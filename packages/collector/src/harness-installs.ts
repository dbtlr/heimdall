import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

import {
  HarnessInstallSchema,
  MAX_HARNESS_INSTALLS,
  UNKNOWN_HARNESS_VERSION,
} from '@heimdall/schema';
import type { HarnessInstall } from '@heimdall/schema';

import { HARNESS_NAMES, HARNESSES } from './harnesses.ts';
import type { Harness } from './harnesses.ts';

export type DirEntry = { isDirectory: boolean; isSymlink: boolean; name: string };

// All the Collector may do to find a Harness: list a directory and read a
// small text file. Each answers undefined for a path that does not exist and
// rejects for one that cannot be read. Nothing here can run a Harness.
export type InstallReader = {
  readDir: (path: string) => Promise<DirEntry[] | undefined>;
  readText: (path: string) => Promise<string | undefined>;
};

const isAbsent = (error: unknown) =>
  error instanceof Error &&
  'code' in error &&
  (error.code === 'ENOENT' || error.code === 'ENOTDIR');

// The most bytes of a file the reader returns. A package.json is a few KiB; a
// bigger file is not one worth reading for a version.
export const MAX_TEXT_BYTES = 64 * 1024;

// The text of a regular file of at most MAX_TEXT_BYTES. The file is opened
// without blocking and checked once open, so a FIFO or device someone put where
// a package.json belongs is refused rather than waited on.
const readSmallFile = async (path: string) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error('not a regular file');
    }
    // A regular file answers a read of this size in one piece, or all of it.
    const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TEXT_BYTES) {
      throw new Error(`larger than ${String(MAX_TEXT_BYTES)} bytes`);
    }
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
};

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
      return await readSmallFile(path);
    } catch (error) {
      if (isAbsent(error)) {
        return undefined;
      }
      throw error;
    }
  },
};

// A release version such as `2.1.296` or `0.5.0-beta.1`, as a directory is
// named or a package.json says. Anything else is not read as a version. The
// bounds keep the longest match within the 64 characters the section allows.
const VERSION = /^\d{1,8}\.\d{1,8}\.\d{1,8}(?:[-+][0-9A-Za-z.+-]{1,36})?$/u;

// Names of installs that are there and carry no release version: a mise
// install of a git ref, and a Homebrew keg built from HEAD.
const MISE_REF = /^ref-[0-9A-Za-z._-]{1,40}$/u;
const HOMEBREW_HEAD = /^HEAD-[0-9A-Za-z._-]{1,40}$/u;

// The answer of a read that failed, kept apart from a path that is absent.
const FAILED = Symbol('failed');

const attempt = async <T>(read: () => Promise<T>): Promise<T | typeof FAILED> => {
  try {
    return await read();
  } catch {
    return FAILED;
  }
};

// Whether `dir` is there though it cannot be listed: its parent can be listed
// and holds an entry of its name. A parent that cannot be listed says nothing
// about what is under it.
const isUnlistable = async (reader: InstallReader, dir: string) => {
  const siblings = await attempt(() => reader.readDir(dirname(dir)));
  return siblings !== FAILED && siblings?.some((e) => e.name === basename(dir)) === true;
};

// A trailing Homebrew revision such as the `_1` of `1.2.3_1`.
const REVISION = /_\d{1,3}$/u;

// The versions of `dir`'s entries. An entry named for a full version counts,
// symbolic link or not, since `mise link` makes the install one; aliases such as
// `latest` or `2.1` are not versions. With `revisions`, a Homebrew revision
// suffix is dropped from the name first. An entry matching `unversioned` is an
// install whose version is unknown, and so is a `dir` that is there (its parent
// lists it) and cannot be listed. A `dir` that is absent, or whose parent
// cannot be listed, has none.
const versionsIn = async (
  reader: InstallReader,
  dir: string,
  {
    directoriesOnly,
    revisions = false,
    unversioned,
  }: { directoriesOnly: boolean; revisions?: boolean; unversioned?: RegExp },
) => {
  const entries = await attempt(() => reader.readDir(dir));
  if (entries === undefined) {
    return [];
  }
  if (entries === FAILED) {
    return (await isUnlistable(reader, dir)) ? [UNKNOWN_HARNESS_VERSION] : [];
  }
  return entries
    .filter((e) => e.isDirectory || e.isSymlink || !directoriesOnly)
    .flatMap((e) => {
      const name = revisions ? e.name.replace(REVISION, '') : e.name;
      if (VERSION.test(name)) {
        return [name];
      }
      return unversioned?.test(e.name) === true ? [UNKNOWN_HARNESS_VERSION] : [];
    });
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
const homebrewPrefixes = (platform: Platform, home: string) =>
  platform === 'darwin'
    ? ['/opt/homebrew', '/usr/local']
    : ['/home/linuxbrew/.linuxbrew', join(home, '.linuxbrew')];

// Where `npm install -g` and its alternatives put packages every Harness may
// use: system and Homebrew prefixes, a user prefix, and bun's global directory.
const sharedNpmRoots = (platform: Platform, home: string) => [
  ...(platform === 'darwin'
    ? ['/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules']
    : ['/usr/lib/node_modules', '/usr/local/lib/node_modules']),
  join(home, '.npm-global/lib/node_modules'),
  join(home, '.local/lib/node_modules'),
  join(home, '.bun/install/global/node_modules'),
];

// The value of a directory variable, when it names an absolute path.
const absoluteDir = (value: string | undefined) =>
  value !== undefined && isAbsolute(value) ? value : undefined;

type Platform = 'darwin' | 'linux';

// The environment variables discovery honors. It is an input, so a test names
// its own and discovery never reads the process's.
export type InstallEnv = Readonly<Record<string, string | undefined>>;

type Discovery = { env: InstallEnv; home: string; platform: Platform; reader: InstallReader };

const installsOf = async (
  harness: Harness,
  { env, home, platform, reader }: Discovery,
): Promise<HarnessInstall[]> => {
  const places = HARNESSES[harness].installs;
  const dataHome = absoluteDir(env.XDG_DATA_HOME) ?? join(home, '.local/share');
  const miseData = absoluteDir(env.MISE_DATA_DIR) ?? join(dataHome, 'mise');
  const found = (location: string, versions: string[]) =>
    versions.map((version) => ({ harness, location, version }));
  const perVersion = async (
    location: string,
    dirs: string[],
    options: { revisions?: boolean; unversioned: RegExp },
  ) =>
    found(
      location,
      (
        await Promise.all(
          dirs.map((dir) => versionsIn(reader, dir, { directoriesOnly: true, ...options })),
        )
      ).flat(),
    );

  const mise = perVersion(
    'mise',
    places.mise.map((tool) => join(miseData, 'installs', tool)),
    { unversioned: MISE_REF },
  );
  const homebrew = perVersion(
    'homebrew',
    homebrewPrefixes(platform, home).flatMap((prefix) =>
      places.homebrew.flatMap((name) => [
        join(prefix, 'Cellar', name),
        join(prefix, 'Caskroom', name),
      ]),
    ),
    { revisions: true, unversioned: HOMEBREW_HEAD },
  );
  const native =
    places.native === undefined
      ? []
      : found(
          'native',
          await versionsIn(reader, join(dataHome, places.native), { directoriesOnly: false }),
        );
  const roots = [
    ...sharedNpmRoots(platform, home),
    ...(places.npmRoots ?? []).map((root) => join(home, root)),
  ];
  const npm = await Promise.all(
    roots.map(async (root) => {
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

// How many installs of one Harness the section keeps, so no Harness crowds out
// another and the section as a whole stays within MAX_HARNESS_INSTALLS.
const MAX_PER_HARNESS = Math.floor(MAX_HARNESS_INSTALLS / HARNESS_NAMES.length);

const compareText = (a: string, b: string) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

// Numeric order of versions, with plain text order to settle those that are
// equal by number (`1.01.0` and `1.1.0`), so the order never depends on the
// order a directory was listed in. An unknown version is the oldest.
const knownRank = (i: HarnessInstall) => (i.version === UNKNOWN_HARNESS_VERSION ? 0 : 1);

const byVersion = (a: HarnessInstall, b: HarnessInstall) =>
  knownRank(a) - knownRank(b) ||
  a.version.localeCompare(b.version, 'en', { numeric: true }) ||
  compareText(a.version, b.version);

const byInstall = (a: HarnessInstall, b: HarnessInstall) =>
  a.harness.localeCompare(b.harness) || a.location.localeCompare(b.location) || byVersion(a, b);

// The installs of one Harness the section can carry: the same install found by
// two paths once, none the schema would refuse, the newest MAX_PER_HARNESS by
// version (ties by location), in the section's order.
const carriable = (installs: HarnessInstall[]) => {
  const unique = new Map(
    installs
      .filter((i) => HarnessInstallSchema.safeParse(i).success)
      .map((i) => [JSON.stringify([i.harness, i.location, i.version]), i]),
  );
  return [...unique.values()]
    .toSorted((a, b) => byVersion(b, a) || a.location.localeCompare(b.location))
    .slice(0, MAX_PER_HARNESS)
    .toSorted(byInstall);
};

// Every install of a Harness on this System, read from install directories and
// package metadata alone, never by running a Harness. Where a version cannot
// be read from an install that is there, it is unknown. A Harness that is not
// installed has none. The list is sorted by Harness, location, and version, and
// each Harness keeps at most MAX_PER_HARNESS, so the whole is within
// MAX_HARNESS_INSTALLS. `env` names the data directories to honor
// (`MISE_DATA_DIR`, `XDG_DATA_HOME`).
export const findHarnessInstalls = async (options: Discovery): Promise<HarnessInstall[]> =>
  (
    await Promise.all(
      HARNESS_NAMES.map(async (harness) => carriable(await installsOf(harness, options))),
    )
  ).flat();
