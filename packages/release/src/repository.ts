import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Change } from './guard.ts';

// The packages a release ships as binaries. They carry one shared version,
// which each binary prints and which the release tag must match.
export const RELEASED_PACKAGES = ['collector', 'hub'] as const;

export const CHANGES_DIR = '.changes';
export const CHANGELOG = 'CHANGELOG.md';

const manifestPath = (root: string, pkg: string) => join(root, 'packages', pkg, 'package.json');

type Manifest = Record<string, unknown> & { version: string };

const isManifest = (value: unknown): value is Manifest =>
  typeof value === 'object' &&
  value !== null &&
  'version' in value &&
  typeof value.version === 'string';

const parseManifest = (pkg: string, text: string): Manifest => {
  const manifest: unknown = JSON.parse(text);
  if (!isManifest(manifest)) {
    throw new Error(`packages/${pkg}/package.json has no version.`);
  }
  return manifest;
};

const readManifest = async (root: string, pkg: string): Promise<Manifest> =>
  parseManifest(pkg, await readFile(manifestPath(root, pkg), 'utf8'));

// The version every released package carries. Packages that disagree are a
// broken cut, so this throws and names each package's version.
export const releaseVersion = async (root: string): Promise<string> => {
  const versions = await Promise.all(
    RELEASED_PACKAGES.map(async (pkg) => ({
      pkg,
      version: (await readManifest(root, pkg)).version,
    })),
  );
  const [first] = versions;
  if (first === undefined || versions.some(({ version }) => version !== first.version)) {
    const listed = versions.map(({ pkg, version }) => `${pkg} is ${version}`).join(', ');
    throw new Error(`The released packages disagree on their version: ${listed}.`);
  }
  return first.version;
};

export const setReleaseVersion = async (root: string, version: string): Promise<void> => {
  await Promise.all(
    RELEASED_PACKAGES.map(async (pkg) => {
      const manifest = await readManifest(root, pkg);
      manifest.version = version;
      await writeFile(manifestPath(root, pkg), `${JSON.stringify(manifest, null, 2)}\n`);
    }),
  );
};

// The pending fragments' paths relative to the root, sorted by name. The guide
// `README.md` is not a fragment.
export const pendingFragments = async (root: string): Promise<string[]> => {
  const entries = await readdir(join(root, CHANGES_DIR), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map((entry) => join(CHANGES_DIR, entry.name))
    .toSorted();
};

// Runs a command in the root and answers its stdout, or throws with its stderr.
const runIn = async (root: string, argv: string[]): Promise<string> => {
  const child = Bun.spawn(argv, { cwd: root, stderr: 'pipe', stdout: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${argv.join(' ')} failed: ${stderr.trim()}`);
  }
  return stdout;
};

// When a fragment landed: the commit time of the commit that added it, in
// seconds. An uncommitted fragment lands last.
const landedAt = async (root: string, path: string): Promise<number> => {
  const stamps = (await runIn(root, ['git', 'log', '--diff-filter=A', '--format=%ct', '--', path]))
    .split('\n')
    .filter((stamp) => stamp.length > 0);
  const oldest = stamps.at(-1);
  return oldest === undefined ? Number.MAX_SAFE_INTEGER : Number(oldest);
};

// Fragments in the order they landed, with the file name breaking ties.
export const inLandingOrder = async (root: string, paths: readonly string[]): Promise<string[]> => {
  const landed = await Promise.all(
    paths.map(async (path) => ({ landed: await landedAt(root, path), path })),
  );
  return landed
    .toSorted((a, b) => a.landed - b.landed || a.path.localeCompare(b.path))
    .map(({ path }) => path);
};

export const removeFragments = async (root: string, paths: readonly string[]): Promise<void> => {
  await Promise.all(paths.map((path) => rm(join(root, path))));
};

// bun.lock records each workspace's version, so a version change rewrites it.
export const refreshLockfile = async (root: string): Promise<void> => {
  await runIn(root, [process.execPath, 'install', '--lockfile-only']);
};

const STATUSES: Record<string, Change['status']> = { A: 'added', D: 'deleted', M: 'modified' };

// The files a pull request changes, from the merge base with `base` to HEAD.
// NUL-separated output keeps every path verbatim, whatever its characters.
export const changesSince = async (root: string, base: string): Promise<Change[]> => {
  const fields = (
    await runIn(root, ['git', 'diff', '-z', '--name-status', '--no-renames', `${base}...HEAD`])
  ).split('\0');
  const changes: Change[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index + 1] ?? '';
    changes.push({ path, status: STATUSES[fields[index] ?? ''] ?? 'modified' });
  }
  return changes;
};

// The Collector's version at `ref`: the base side of a release cut.
export const releaseVersionAt = async (root: string, ref: string): Promise<string> => {
  const [pkg] = RELEASED_PACKAGES;
  const text = await runIn(root, ['git', 'show', `${ref}:packages/${pkg}/package.json`]);
  return parseManifest(pkg, text).version;
};
