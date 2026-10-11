import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_HARNESS_INSTALLS, UNKNOWN_HARNESS_VERSION } from '@heimdall/schema';
import type { HarnessInstall } from '@heimdall/schema';

import { HARNESS_NAMES, HARNESSES } from './harnesses.ts';
import type { Harness } from './harnesses.ts';

export type DirEntry = { isDirectory: boolean; isSymlink: boolean; name: string };

// All the Collector may do to find a Harness: list a directory and read a
// text file. Each answers undefined for a path that does not exist and rejects
// for one that cannot be read. Nothing here can run a Harness.
export type InstallReader = {
  readDir: (path: string) => Promise<DirEntry[] | undefined>;
  readText: (path: string) => Promise<string | undefined>;
};

const isAbsent = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

// The reader over the real filesystem.
export const fileReader: InstallReader = {
  readDir: async (path) => {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => ({
        isDirectory: e.isDirectory(),
        isSymlink: e.isSymbolicLink(),
        name: e.name,
      }));
    } catch (error) {
      if (isAbsent(error)) {
        return undefined;
      }
      throw error;
    }
  },
  readText: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isAbsent(error)) {
        return undefined;
      }
      throw error;
    }
  },
};

// A release version such as `2.1.296` or `0.5.0-beta.1`, as a directory is
// named or a package.json says. Anything else is not read as a version.
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,40})?$/u;

// The answer of a read that failed, kept apart from a path that is absent.
const FAILED = Symbol('failed');

const attempt = async <T>(read: () => Promise<T>): Promise<T | typeof FAILED> => {
  try {
    return await read();
  } catch {
    return FAILED;
  }
};

// The names of `dir`'s entries that are versions, and are not aliases such as
// mise's `latest` or `2.1` links. A directory that is absent or cannot be
// listed has none.
const versionsIn = async (
  reader: InstallReader,
  dir: string,
  { directoriesOnly }: { directoriesOnly: boolean },
) => {
  const entries = await attempt(() => reader.readDir(dir));
  if (entries === FAILED || entries === undefined) {
    return [];
  }
  return entries
    .filter((e) => !e.isSymlink && (e.isDirectory || !directoriesOnly) && VERSION.test(e.name))
    .map((e) => e.name);
};

// The version in a global npm package's package.json: unknown when the package
// directory is there and the file cannot be read or has no version.
const npmVersion = async (reader: InstallReader, packageDir: string) => {
  const text = await attempt(() => reader.readText(join(packageDir, 'package.json')));
  if (text === FAILED || text === undefined) {
    return UNKNOWN_HARNESS_VERSION;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const version =
      typeof parsed === 'object' && parsed !== null && 'version' in parsed
        ? parsed.version
        : undefined;
    return typeof version === 'string' && VERSION.test(version) ? version : UNKNOWN_HARNESS_VERSION;
  } catch {
    return UNKNOWN_HARNESS_VERSION;
  }
};

// Whether `dir` is there, even if it cannot be listed.
const exists = async (reader: InstallReader, dir: string) => {
  const entries = await attempt(() => reader.readDir(dir));
  return entries === FAILED || entries !== undefined;
};

// Homebrew prefixes by platform: Apple Silicon and Intel on macOS, Linuxbrew
// system-wide and in the home directory on Linux.
const homebrewPrefixes = (platform: 'darwin' | 'linux', home: string) =>
  platform === 'darwin'
    ? ['/opt/homebrew', '/usr/local']
    : ['/home/linuxbrew/.linuxbrew', join(home, '.linuxbrew')];

// Where `npm install -g` and its alternatives put packages: system and
// Homebrew prefixes, a user prefix, bun's global directory, and Claude Code's
// own local installer.
const npmRoots = (platform: 'darwin' | 'linux', home: string) => [
  ...(platform === 'darwin'
    ? ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules']
    : ['/usr/lib/node_modules', '/usr/local/lib/node_modules']),
  join(home, '.npm-global/lib/node_modules'),
  join(home, '.local/lib/node_modules'),
  join(home, '.bun/install/global/node_modules'),
  join(home, '.claude/local/node_modules'),
];

const installsOf = async (
  harness: Harness,
  { home, platform, reader }: { home: string; platform: 'darwin' | 'linux'; reader: InstallReader },
): Promise<HarnessInstall[]> => {
  const places = HARNESSES[harness].installs;
  const found = (location: string, versions: string[]) =>
    versions.map((version) => ({ harness, location, version }));
  const perVersion = async (location: string, dirs: string[]) =>
    found(
      location,
      (
        await Promise.all(dirs.map((dir) => versionsIn(reader, dir, { directoriesOnly: true })))
      ).flat(),
    );

  const mise = perVersion(
    'mise',
    places.mise.map((tool) => join(home, '.local/share/mise/installs', tool)),
  );
  const homebrew = perVersion(
    'homebrew',
    homebrewPrefixes(platform, home).flatMap((prefix) =>
      places.homebrew.flatMap((name) => [
        join(prefix, 'Cellar', name),
        join(prefix, 'Caskroom', name),
      ]),
    ),
  );
  const native =
    places.native === undefined
      ? []
      : found(
          'native',
          await versionsIn(reader, join(home, places.native), { directoriesOnly: false }),
        );
  const npm = await Promise.all(
    npmRoots(platform, home).map(async (root) => {
      // A root that cannot be listed says nothing about the packages in it.
      const listing = await attempt(() => reader.readDir(root));
      if (listing === FAILED || listing === undefined) {
        return [];
      }
      return Promise.all(
        places.npm.map(async (name) => {
          const dir = join(root, name);
          return (await exists(reader, dir)) ? found('npm', [await npmVersion(reader, dir)]) : [];
        }),
      );
    }),
  );
  return [...(await mise), ...(await homebrew), ...native, ...npm.flat(2)];
};

const byInstall = (a: HarnessInstall, b: HarnessInstall) =>
  a.harness.localeCompare(b.harness) ||
  a.location.localeCompare(b.location) ||
  a.version.localeCompare(b.version, 'en', { numeric: true });

// Every install of a Harness on this System, read from install directories and
// package metadata alone, never by running a Harness. Where a version cannot
// be read from an install that is there, it is unknown. A Harness that is not
// installed has none. The same install found by two paths counts once. The
// list is sorted by Harness, location, and version, and holds at most
// MAX_HARNESS_INSTALLS.
export const findHarnessInstalls = async (options: {
  home: string;
  platform: 'darwin' | 'linux';
  reader: InstallReader;
}): Promise<HarnessInstall[]> => {
  const all = (
    await Promise.all(HARNESS_NAMES.map((harness) => installsOf(harness, options)))
  ).flat();
  const unique = new Map(all.map((i) => [JSON.stringify([i.harness, i.location, i.version]), i]));
  return [...unique.values()].toSorted(byInstall).slice(0, MAX_HARNESS_INSTALLS);
};
