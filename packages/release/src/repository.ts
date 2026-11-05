import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Change } from './guard.ts';

// The packages a release ships as binaries. They carry one shared version,
// which each binary prints and which the release tag must match.
export const RELEASED_PACKAGES = ['collector', 'dashboard', 'hub'] as const;

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

// Where `loom changelog` runs: the package whose loom.config.json points at the
// repository's fragments and changelog and lists the other released packages.
const LOOM_PACKAGE = join('packages', RELEASED_PACKAGES[0]);

// Validates every pending fragment with `loom changelog check`, the grammar the
// cut compiles. Answers Loom's own report of the invalid ones, or undefined.
export const checkFragments = async (root: string): Promise<string | undefined> => {
  const child = Bun.spawn([process.execPath, 'run', 'loom', 'changelog', 'check'], {
    cwd: join(root, LOOM_PACKAGE),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return code === 0 ? undefined : stderr.trim();
};
