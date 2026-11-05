import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertAssembles, mockProcess } from '@loomcli/testing';

import { app } from './application.ts';

const HEADER = '# Changelog\n\nReleased Heimdall changes.\n';

let repo: string;

const git = async (args: string[], env: Record<string, string> = {}) => {
  const child = Bun.spawn(['git', ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    stderr: 'pipe',
  });
  if ((await child.exited) !== 0) {
    throw new Error(await new Response(child.stderr).text());
  }
};

const gitOutput = async (args: string[]) => {
  const child = Bun.spawn(['git', ...args], { cwd: repo, stderr: 'pipe', stdout: 'pipe' });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) {
    throw new Error(await new Response(child.stderr).text());
  }
  return stdout;
};

const write = async (path: string, content: string) => {
  await mkdir(join(repo, path, '..'), { recursive: true });
  await writeFile(join(repo, path), content);
};

const commitAll = async (message: string) => {
  await git(['add', '--all']);
  await git(['commit', '--quiet', '-m', message]);
};

// The Collector's installed dependencies, which hold the `loom` the guard runs.
const COLLECTOR_MODULES = join(import.meta.dir, '../../collector/node_modules');

const LOOM_CONFIG = JSON.stringify({
  paths: { changelog: '../../CHANGELOG.md', changes: '../../.changes' },
  sharedVersion: ['../hub/package.json', '../dashboard/package.json'],
});

// A throwaway repository shaped like Heimdall's: released packages at one
// version, a changelog, and the fragments listed, with Loom configured as it is
// in the Collector's package directory.
const fixture = async ({
  fragments = [],
  versions = { collector: '0.1.0', dashboard: '0.1.0', hub: '0.1.0' },
  changelog = HEADER,
}: {
  fragments?: [name: string, content: string][];
  versions?: { collector: string; dashboard: string; hub: string };
  changelog?: string;
} = {}) => {
  repo = await mkdtemp(join(tmpdir(), 'heimdall-release-'));
  await git(['init', '--quiet']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await write('package.json', JSON.stringify({ private: true, workspaces: ['packages/*'] }));
  await Promise.all([
    ...Object.entries(versions).map(([pkg, version]) =>
      write(
        `packages/${pkg}/package.json`,
        `${JSON.stringify({ name: `@heimdall/${pkg}`, private: true, version }, null, 2)}\n`,
      ),
    ),
    write('CHANGELOG.md', changelog),
    write('.changes/README.md', '# Changelog fragments\n'),
    write('packages/collector/loom.config.json', LOOM_CONFIG),
    ...fragments.map(([name, content]) => write(`.changes/${name}`, content)),
  ]);
  await symlink(COLLECTOR_MODULES, join(repo, 'packages/collector/node_modules'));
  await write('.gitignore', 'node_modules\n');
  await commitAll('init');
};

// `repo` is unset until a test builds a fixture.
afterEach(async () => {
  if (repo !== undefined) {
    await rm(repo, { force: true, recursive: true });
  }
});

test('the application assembles', () => {
  assertAssembles(app);
});

const invoke = async (argv: string[]) => {
  const mock = mockProcess({ argv, cwd: repo });
  const code = await app.run({ process: mock });
  return { code, stderr: mock.stderr.text, stdout: mock.stdout.text };
};

test('version prints the release version the Collector and Hub share', async () => {
  await fixture({ versions: { collector: '0.3.1', dashboard: '0.3.1', hub: '0.3.1' } });
  expect(await invoke(['version'])).toEqual({ code: 0, stderr: '', stdout: '0.3.1\n' });
});

test('version fails when the Collector and Hub disagree', async () => {
  await fixture({ versions: { collector: '0.3.1', dashboard: '0.3.1', hub: '0.3.0' } });
  const { code, stderr, stdout } = await invoke(['version']);
  expect(stdout).toBe('');
  expect(stderr).toContain('collector is 0.3.1');
  expect(stderr).toContain('hub is 0.3.0');
  expect(code).toBe(1);
});

// The PR under guard: the fixture's last commit is its base, and the files
// given are committed on top as the PR's head.
const openPullRequest = async (files: Record<string, string | null>) => {
  const base = (await gitOutput(['rev-parse', 'HEAD'])).trim();
  await Promise.all(
    Object.entries(files).map(([path, content]) =>
      content === null ? rm(join(repo, path)) : write(path, content),
    ),
  );
  await git(['add', '--all']);
  await git(['commit', '--quiet', '-m', 'pr']);
  return base;
};

const FEATURE = '- Add a thing.\n';

test('changelog guard fails a shipped change without a fragment', async () => {
  await fixture();
  const base = await openPullRequest({ 'packages/collector/src/ünicode.ts': 'x' });
  const { code, stderr } = await invoke(['changelog', 'guard', '--base', base]);
  expect(stderr).toContain('adds no fragment');
  expect(code).toBe(1);
});

test('changelog guard passes a shipped change with the skip label', async () => {
  await fixture();
  const base = await openPullRequest({ 'packages/collector/src/a.ts': 'x' });
  const { code, stdout } = await invoke(['changelog', 'guard', '--base', base, '--skip-label']);
  expect(stdout).toContain('skip-changelog label');
  expect(code).toBe(0);
});

test('changelog guard passes a shipped change with a valid feature fragment', async () => {
  await fixture();
  const base = await openPullRequest({
    '.changes/feature.hmd-1-thing.md': FEATURE,
    'packages/collector/src/a.ts': 'x',
  });
  const { code, stdout } = await invoke(['changelog', 'guard', '--base', base]);
  expect(stdout).toContain('Fragments present: .changes/feature.hmd-1-thing.md.');
  expect(code).toBe(0);
});

test('changelog guard passes a fix fragment with no kind prefix', async () => {
  await fixture();
  const base = await openPullRequest({
    '.changes/hmd-1-thing.md': FEATURE,
    'packages/collector/src/a.ts': 'x',
  });
  expect((await invoke(['changelog', 'guard', '--base', base])).code).toBe(0);
});

test('changelog guard fails a fragment written with Keep a Changelog headings', async () => {
  await fixture();
  const base = await openPullRequest({
    '.changes/feature.hmd-1-thing.md': '### Added\n\n- Add a thing.\n',
    'packages/collector/src/a.ts': 'x',
  });
  const { code, stderr } = await invoke(['changelog', 'guard', '--base', base]);
  expect(stderr).toContain('.changes/feature.hmd-1-thing.md');
  expect(code).toBe(1);
});

test('changelog guard fails a breaking fragment without a migration section', async () => {
  await fixture();
  const base = await openPullRequest({ '.changes/breaking.hmd-1-thing.md': FEATURE });
  const { code, stderr } = await invoke(['changelog', 'guard', '--base', base]);
  expect(stderr).toContain('Migration');
  expect(code).toBe(1);
});

test('changelog guard fails a bare kind as a fragment name', async () => {
  await fixture();
  const base = await openPullRequest({ '.changes/feature.md': FEATURE });
  const { code, stderr } = await invoke(['changelog', 'guard', '--base', base]);
  expect(stderr).toContain('.changes/feature.md');
  expect(code).toBe(1);
});

test('changelog guard checks an added fragment even when nothing that ships changed', async () => {
  await fixture();
  const base = await openPullRequest({ '.changes/bad.md': 'Just prose\n' });
  const { code } = await invoke(['changelog', 'guard', '--base', base]);
  expect(code).toBe(1);
});

test('changelog guard passes the release cut that loom changelog write prepares', async () => {
  await fixture({ fragments: [['feature.hmd-1-thing.md', FEATURE]] });
  const base = (await gitOutput(['rev-parse', 'HEAD'])).trim();
  // The cut: Loom's own write, then the lockfile it leaves to the package manager.
  const cut = Bun.spawn(
    [process.execPath, 'run', 'loom', 'changelog', 'write', '--target', '0.2.0'],
    { cwd: join(repo, 'packages/collector'), stderr: 'pipe', stdout: 'pipe' },
  );
  expect(await cut.exited).toBe(0);
  await write('bun.lock', 'lock\n');
  await commitAll('cut');

  const { code, stdout } = await invoke(['changelog', 'guard', '--base', base]);

  expect(stdout).toContain('The release cut');
  expect(code).toBe(0);
});

const guardAgainst = async (base: string, ...flags: string[]) =>
  invoke(['changelog', 'guard', '--base', base, ...flags]);

// Fragments hold plain text with LF line endings, which Loom's grammar alone
// does not enforce.
test.each([
  ['an escape sequence', '- \u001b[31mred\n'],
  ['a NUL', '- a\u0000b\n'],
  ['a CRLF line ending', '- ok\r\n'],
  ['a right-to-left override', '- a\u202eb\n'],
  ['a zero-width space', '- a\u200bb\n'],
])('changelog guard fails a fragment holding %s', async (_name, content) => {
  await fixture();
  const base = await openPullRequest({ '.changes/feature.hmd-1-thing.md': content });
  const { code, stderr } = await guardAgainst(base);
  expect(stderr).toContain('.changes/feature.hmd-1-thing.md');
  expect(stderr).toContain('control character or invisible mark');
  expect(code).toBe(1);
});

test('changelog guard fails a fragment that is not valid UTF-8', async () => {
  await fixture();
  const base = (await gitOutput(['rev-parse', 'HEAD'])).trim();
  await writeFile(join(repo, '.changes/feature.hmd-1-thing.md'), Buffer.from([45, 32, 255, 10]));
  await commitAll('pr');
  const { code, stderr } = await guardAgainst(base);
  expect(stderr).toContain('.changes/feature.hmd-1-thing.md');
  expect(stderr).toContain('not valid UTF-8');
  expect(code).toBe(1);
});

test('changelog guard scans fragments the PR did not touch', async () => {
  await fixture({ fragments: [['feature.hmd-1-old.md', '- a\u202eb\n']] });
  const base = await openPullRequest({ 'packages/collector/src/a.ts': 'x' });
  expect((await guardAgainst(base, '--skip-label')).code).toBe(1);
});

test('changelog guard fails when Loom cannot read its configuration', async () => {
  await fixture();
  const base = await openPullRequest({
    '.changes/feature.hmd-1-thing.md': 'Just prose\n',
    'packages/collector/loom.config.json': '{',
  });
  const { code, stderr } = await guardAgainst(base);
  expect(stderr).toContain('checked 0');
  expect(code).toBe(1);
});

test('changelog guard fails when Loom is pointed away from .changes', async () => {
  await fixture();
  const base = await openPullRequest({
    '.changes/feature.hmd-1-thing.md': 'Just prose\n',
    '.changes/feature.hmd-3-more.md': FEATURE,
    'other/feature.hmd-2-other.md': FEATURE,
    'packages/collector/loom.config.json': JSON.stringify({
      paths: { changelog: '../../CHANGELOG.md', changes: '../../other' },
      sharedVersion: ['../hub/package.json', '../dashboard/package.json'],
    }),
  });
  const { code, stderr } = await guardAgainst(base);
  expect(stderr).toContain('checked 1 fragments, but 2 are pending');
  expect(code).toBe(1);
});

test('changelog guard prints Loom failures one per line, without bun or ../../ noise', async () => {
  await fixture();
  const base = await openPullRequest({ '.changes/bad.md': 'Just prose\n' });
  const { code, stderr } = await guardAgainst(base);
  expect(stderr).toContain('.changes/bad.md');
  expect(stderr).not.toContain('../../');
  expect(stderr).not.toContain('exited with code');
  expect(stderr).not.toContain(String.raw`\u000a`);
  expect(code).toBe(1);
});

test('changelog guard checks the fragments even with the skip label', async () => {
  await fixture();
  const base = await openPullRequest({
    '.changes/feature.hmd-1-thing.md': 'Just prose\n',
    'packages/collector/src/a.ts': 'x',
  });
  expect((await guardAgainst(base, '--skip-label')).code).toBe(1);
});

test.each(['.changes/sub/x.md', '.changes/x.txt'])(
  'changelog guard fails a stray %s even when the PR changed no fragment',
  async (path) => {
    await fixture();
    const base = await openPullRequest({ 'packages/collector/src/a.ts': 'x', [path]: 'stray\n' });
    expect((await guardAgainst(base, '--skip-label')).code).toBe(1);
  },
);

test('changelog guard fails cut-shaped files without a version bump', async () => {
  await fixture({ fragments: [['feature.hmd-1-thing.md', FEATURE]] });
  const base = await openPullRequest({
    '.changes/feature.hmd-1-thing.md': null,
    'CHANGELOG.md': `${HEADER}\n## v9.9.9\n`,
    'bun.lock': 'lock\n',
  });
  const { code, stderr } = await guardAgainst(base);
  expect(stderr).toContain('adds no fragment');
  expect(code).toBe(1);
});

test('changelog guard reports that Loom cannot run', async () => {
  await fixture();
  const base = await openPullRequest({ 'packages/collector/src/a.ts': 'x' });
  await rm(join(repo, 'packages/collector/node_modules'));
  const { code, stderr } = await guardAgainst(base, '--skip-label');
  expect(stderr).toContain('Could not run loom changelog check');
  expect(code).toBe(1);
});
