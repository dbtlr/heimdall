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

test.each(['v0.2.0', '0.2', 'latest'])(
  'changelog write rejects the version %j',
  async (version) => {
    await fixture({ fragments: [['a.md', '### Fixed\n\n- A.\n']] });
    const { code, stderr } = await invoke(['changelog', 'write', '--version', version]);
    expect(stderr).toContain('--version');
    expect(code).toBe(2);
  },
);

test('changelog write accepts a prerelease version', async () => {
  await fixture({ fragments: [['a.md', '### Fixed\n\n- A.\n']] });
  const { code } = await invoke(['changelog', 'write', '--version', '0.2.0-rc.1']);
  expect(await versionOf('collector')).toBe('0.2.0-rc.1');
  expect(code).toBe(0);
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
