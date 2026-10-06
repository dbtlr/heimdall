import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

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

const read = (path: string) => readFile(join(repo, path), 'utf8');

const versionOf = async (pkg: string) =>
  (JSON.parse(await read(`packages/${pkg}/package.json`)) as { version: string }).version;

const commitFragment = async (index: number, name: string, content: string) => {
  await write(`.changes/${name}`, content);
  await git(['add', '.']);
  await git(['commit', '--quiet', '-m', name], {
    GIT_COMMITTER_DATE: `${String(1_790_000_000 + index * 60)} +0000`,
  });
};

// A throwaway repository shaped like Heimdall's: released packages at one
// version, a changelog, and fragments committed in the order listed.
const fixture = async ({
  fragments = [],
  versions = { collector: '0.1.0', hub: '0.1.0' },
  changelog = HEADER,
}: {
  fragments?: [name: string, content: string][];
  versions?: { collector: string; hub: string };
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
  ]);
  await git(['add', '.']);
  await git(['commit', '--quiet', '-m', 'init']);
  // One commit per fragment, a minute apart, so landing order is unambiguous.
  for (const [index, [name, content]] of fragments.entries()) {
    // oxlint-disable-next-line no-await-in-loop -- each fragment lands in its own commit.
    await commitFragment(index, name, content);
  }
};

afterEach(async () => {
  await rm(repo, { force: true, recursive: true });
});

const invoke = async (argv: string[]) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Loom sets process.exitCode even for an injected host; keep it off the test runner.
  const runnerExitCode = process.exitCode;
  let code: number;
  try {
    code = await app.run({ host: { argv, cwd: repo, env: {}, stderr, stdout } });
  } finally {
    process.exitCode = runnerExitCode;
  }
  stdout.end();
  stderr.end();
  return { code, stderr: await text(stderr), stdout: await text(stdout) };
};

test('version prints the release version the Collector and Hub share', async () => {
  await fixture({ versions: { collector: '0.3.1', hub: '0.3.1' } });
  expect(await invoke(['version'])).toEqual({ code: 0, stderr: '', stdout: '0.3.1\n' });
});

test('version fails when the Collector and Hub disagree', async () => {
  await fixture({ versions: { collector: '0.3.1', hub: '0.3.0' } });
  const { code, stderr, stdout } = await invoke(['version']);
  expect(stdout).toBe('');
  expect(stderr).toContain('collector is 0.3.1');
  expect(stderr).toContain('hub is 0.3.0');
  expect(code).toBe(1);
});

test('changelog check accepts every pending fragment', async () => {
  await fixture({
    fragments: [
      ['a.md', '### Added\n\n- A.\n'],
      ['b.md', '### Fixed\n\n- B.\n'],
    ],
  });
  const { code, stdout } = await invoke(['changelog', 'check']);
  expect(stdout).toBe('2 fragments parse.\n');
  expect(code).toBe(0);
});

test('changelog check names each malformed fragment and its line', async () => {
  await fixture({
    fragments: [
      ['bad.md', '### Added\n\nProse.\n'],
      ['good.md', '### Added\n\n- A.\n'],
    ],
  });
  const { code, stderr } = await invoke(['changelog', 'check']);
  expect(stderr).toContain('.changes/bad.md:3: prose outside a bullet');
  expect(stderr).not.toContain('good.md');
  expect(code).toBe(1);
});

test('changelog check reads only the fragments it is given', async () => {
  await fixture({
    fragments: [
      ['bad.md', '- Prose.\n'],
      ['good.md', '### Added\n\n- A.\n'],
    ],
  });
  const { code, stdout } = await invoke(['changelog', 'check', '.changes/good.md']);
  expect(stdout).toBe('1 fragment parses.\n');
  expect(code).toBe(0);
});

test('changelog write cuts a release from the pending fragments in landing order', async () => {
  await fixture({
    changelog: `${HEADER}\n## v0.1.0 - 2026-10-01\n\n### Added\n\n- First.\n`,
    // Committed z first, so z lands before a despite sorting after it.
    fragments: [
      ['z.md', '### Fixed\n\n- Z.\n'],
      ['a.md', '### Fixed\n\n- A.\n\n### Added\n\n- New.\n'],
    ],
  });

  const { code, stdout } = await invoke([
    'changelog',
    'write',
    '--version',
    '0.2.0',
    '--date',
    '2026-10-06',
  ]);

  expect(await read('CHANGELOG.md')).toBe(
    `${HEADER}\n## v0.2.0 - 2026-10-06\n\n### Added\n\n- New.\n\n### Fixed\n\n- Z.\n- A.\n\n## v0.1.0 - 2026-10-01\n\n### Added\n\n- First.\n`,
  );
  expect(await versionOf('collector')).toBe('0.2.0');
  expect(await versionOf('hub')).toBe('0.2.0');
  expect(await read('bun.lock')).toContain('"version": "0.2.0"');
  expect(await Bun.file(join(repo, '.changes/z.md')).exists()).toBe(false);
  expect(await Bun.file(join(repo, '.changes/a.md')).exists()).toBe(false);
  expect(await Bun.file(join(repo, '.changes/README.md')).exists()).toBe(true);
  expect(stdout).toBe('Wrote v0.2.0 from 2 fragments.\n');
  expect(code).toBe(0);
});

test('changelog write refuses a release with no pending fragments', async () => {
  await fixture();
  const { code, stderr } = await invoke(['changelog', 'write', '--version', '0.2.0']);
  expect(stderr).toContain('No pending fragments');
  expect(code).toBe(1);
});

test('changelog write refuses a release the changelog already holds and changes nothing', async () => {
  const changelog = `${HEADER}\n## v0.2.0 - 2026-10-01\n\n### Added\n\n- First.\n`;
  await fixture({ changelog, fragments: [['a.md', '### Fixed\n\n- A.\n']] });
  const { code, stderr } = await invoke(['changelog', 'write', '--version', '0.2.0']);
  expect(stderr).toContain('already holds v0.2.0');
  expect(await read('CHANGELOG.md')).toBe(changelog);
  expect(await Bun.file(join(repo, '.changes/a.md')).exists()).toBe(true);
  expect(code).toBe(1);
});

test('changelog write changes nothing when a fragment is malformed', async () => {
  await fixture({
    fragments: [
      ['a.md', '### Fixed\n\n- A.\n'],
      ['bad.md', 'Prose.\n'],
    ],
  });
  const { code, stderr } = await invoke(['changelog', 'write', '--version', '0.2.0']);
  expect(stderr).toContain('.changes/bad.md:1');
  expect(await read('CHANGELOG.md')).toBe(HEADER);
  expect(await versionOf('hub')).toBe('0.1.0');
  expect(code).toBe(1);
});

test.each(['v0.2.0', '0.2', 'latest', '0.2.0-', '0.2.0-rc..1', '0.2.0-.', '0.2.0-01', '02.0.0'])(
  'changelog write rejects the version %j',
  async (version) => {
    await fixture({ fragments: [['a.md', '### Fixed\n\n- A.\n']] });
    const { code, stderr } = await invoke(['changelog', 'write', '--version', version]);
    expect(stderr).toContain('--version');
    expect(code).toBe(2);
  },
);

test('changelog write refuses a cut when a released package has no version and changes nothing', async () => {
  await fixture({ fragments: [['a.md', '### Fixed\n\n- A.\n']] });
  await write('packages/hub/package.json', '{ "name": "@heimdall/hub" }\n');

  const { code, stderr } = await invoke(['changelog', 'write', '--version', '0.2.0']);

  expect(stderr).toContain('packages/hub/package.json has no version');
  expect(await read('CHANGELOG.md')).toBe(HEADER);
  expect(await versionOf('collector')).toBe('0.1.0');
  expect(await Bun.file(join(repo, '.changes/a.md')).exists()).toBe(true);
  expect(code).toBe(1);
});

test('changelog write for a prerelease sets the version and leaves the fragments pending', async () => {
  await fixture({ fragments: [['a.md', '### Fixed\n\n- A.\n']] });

  const { code, stdout } = await invoke(['changelog', 'write', '--version', '0.2.0-rc.1']);

  expect(stdout).toBe('Set v0.2.0-rc.1; 1 fragment stays pending for the release.\n');
  expect(await versionOf('collector')).toBe('0.2.0-rc.1');
  expect(await versionOf('hub')).toBe('0.2.0-rc.1');
  expect(await read('CHANGELOG.md')).toBe(HEADER);
  expect(await Bun.file(join(repo, '.changes/a.md')).exists()).toBe(true);
  expect(code).toBe(0);
});

test('a release after its prerelease compiles the fragments the prerelease left', async () => {
  await fixture({
    fragments: [['a.md', '### Fixed\n\n- A.\n']],
    versions: { collector: '0.2.0-rc.1', hub: '0.2.0-rc.1' },
  });

  const { code } = await invoke([
    'changelog',
    'write',
    '--version',
    '0.2.0',
    '--date',
    '2026-10-06',
  ]);

  expect(await read('CHANGELOG.md')).toBe(
    `${HEADER}\n## v0.2.0 - 2026-10-06\n\n### Fixed\n\n- A.\n`,
  );
  expect(await versionOf('hub')).toBe('0.2.0');
  expect(code).toBe(0);
});

test("changelog notes for a prerelease prints the pending fragments' entries", async () => {
  await fixture({
    fragments: [
      ['z.md', '### Fixed\n\n- Z.\n'],
      ['a.md', '### Added\n\n- A.\n'],
    ],
  });
  expect(await invoke(['changelog', 'notes', '--version', '0.2.0-rc.1'])).toEqual({
    code: 0,
    stderr: '',
    stdout: '### Added\n\n- A.\n\n### Fixed\n\n- Z.\n',
  });
});

test('changelog notes for a prerelease fails when no fragment is pending', async () => {
  await fixture();
  const { code, stderr } = await invoke(['changelog', 'notes', '--version', '0.2.0-rc.1']);
  expect(stderr).toContain('No pending fragments');
  expect(code).toBe(1);
});

test("changelog notes prints one release's entries", async () => {
  await fixture({
    changelog: `${HEADER}\n## v0.2.0 - 2026-10-06\n\n### Fixed\n\n- Z.\n- A.\n\n## v0.1.0 - 2026-10-01\n\n### Added\n\n- First.\n`,
  });
  expect(await invoke(['changelog', 'notes', '--version', '0.2.0'])).toEqual({
    code: 0,
    stderr: '',
    stdout: '### Fixed\n\n- Z.\n- A.\n',
  });
});

test('changelog notes fails for a release the changelog does not hold', async () => {
  await fixture();
  const { code, stderr } = await invoke(['changelog', 'notes', '--version', '0.9.0']);
  expect(stderr).toContain('CHANGELOG.md has no v0.9.0 section');
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

test('changelog guard parses an added fragment even when nothing that ships changed', async () => {
  await fixture();
  const base = await openPullRequest({ '.changes/bad.md': 'Just prose\n' });
  const { code, stderr } = await invoke(['changelog', 'guard', '--base', base]);
  expect(stderr).toContain('.changes/bad.md:1: prose outside a bullet');
  expect(code).toBe(1);
});

test('changelog guard passes a shipped change with a fragment that parses', async () => {
  await fixture();
  const base = await openPullRequest({
    '.changes/hmd-1.md': '### Added\n\n- A.\n',
    'packages/collector/src/a.ts': 'x',
  });
  const { code, stdout } = await invoke(['changelog', 'guard', '--base', base]);
  expect(stdout).toContain('Fragments present: .changes/hmd-1.md.');
  expect(code).toBe(0);
});

test('changelog guard passes the release cut that changelog write prepares', async () => {
  await fixture({ fragments: [['hmd-1.md', '### Added\n\n- A.\n']] });
  const base = (await gitOutput(['rev-parse', 'HEAD'])).trim();
  expect((await invoke(['changelog', 'write', '--version', '0.2.0'])).code).toBe(0);
  await git(['add', '--all']);
  await git(['commit', '--quiet', '-m', 'cut']);

  const { code, stdout } = await invoke(['changelog', 'guard', '--base', base]);

  expect(stdout).toContain('The release cut');
  expect(code).toBe(0);
});

test('changelog guard fails a shipped change that deletes a fragment and adds none', async () => {
  await fixture({ fragments: [['old.md', '### Added\n\n- A.\n']] });
  const base = await openPullRequest({
    '.changes/old.md': null,
    'packages/collector/src/a.ts': 'x',
  });
  const { code } = await invoke(['changelog', 'guard', '--base', base]);
  expect(code).toBe(1);
});
