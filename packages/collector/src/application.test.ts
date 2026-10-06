import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import { app } from './application.ts';
import { tempStateDir } from './testing/fixtures.ts';
import { versionLine } from './version.ts';

// Runs the Collector command line in-process and captures what it prints. A run
// that starts collecting is cancelled once stderr shows it started, or after a
// few seconds, so a `run` test ends either way.
const invoke = async (
  argv: string[],
  { cwd, env = {} }: { cwd?: string; env?: Record<string, string> } = {},
) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 5000);
  let printed = '';
  stderr.on('data', (chunk: Buffer) => {
    printed += chunk.toString();
    if (printed.includes('Sampling ')) {
      controller.abort();
    }
  });
  // Loom sets process.exitCode even for an injected host; keep it off the test runner.
  const runnerExitCode = process.exitCode;
  let code: number;
  try {
    code = await app.run({
      host: { argv, env, stderr, stdout, ...(cwd === undefined ? {} : { cwd }) },
      signal: controller.signal,
    });
  } finally {
    process.exitCode = runnerExitCode;
    clearTimeout(safety);
  }
  stdout.end();
  stderr.end();
  return { code, stderr: printed, stdout: await text(stdout) };
};

test('--version prints the version line Fleet compares and exits 0', async () => {
  const { code, stderr, stdout } = await invoke(['--version']);
  expect(stdout).toBe(`${versionLine()}\n`);
  expect(stderr).toBe('');
  expect(code).toBe(0);
});

test('a bare invocation is a usage error', async () => {
  const { code, stderr, stdout } = await invoke([]);
  expect(stdout).toBe('');
  expect(stderr).toContain('run');
  expect(stderr).toContain('heimdall-collector --help');
  expect(code).toBe(2);
});

test('an unknown option is a usage error', async () => {
  const { code, stderr, stdout } = await invoke(['--bogus']);
  expect(stdout).toBe('');
  expect(stderr).toContain('--bogus');
  expect(code).toBe(2);
});

test('a stray argument is a usage error', async () => {
  const { code, stderr, stdout } = await invoke(['run', 'now']);
  expect(stdout).toBe('');
  expect(stderr).toContain('accepts no arguments');
  expect(code).toBe(2);
});

// A run cancelled as soon as it starts: enough to see which settings it resolved.
const startAndStop = (argv: string[], env: Record<string, string> = {}) => invoke(argv, { env });

test('run reads its settings from the configuration file', async () => {
  await using dir = await tempStateDir();
  const configFile = join(dir.path, 'collector.toml');
  await writeFile(
    configFile,
    [
      'hub = "http://heimdall.example:8080/"',
      'system = "server-1"',
      'token = "s3cret"',
      `stateDir = "${join(dir.path, 'state')}"`,
    ].join('\n'),
  );

  const { code, stderr } = await startAndStop(['run', '--config', configFile]);

  expect(stderr).toContain('Sampling server-1 every 15 seconds for http://heimdall.example:8080/');
  expect(stderr).not.toContain('s3cret');
  expect(await Bun.file(join(dir.path, 'state', 'queue.sqlite')).exists()).toBe(true);
  expect(code).toBe(130);
});

test('run finds the configuration file under ~/.config/heimdall/ when --config is absent', async () => {
  await using home = await tempStateDir();
  await using elsewhere = await tempStateDir();
  await mkdir(join(home.path, '.config', 'heimdall'), { recursive: true });
  await writeFile(
    join(home.path, '.config', 'heimdall', 'collector.toml'),
    [
      'hub = "http://heimdall.example:8080/"',
      'system = "server-1"',
      'token = "s3cret"',
      `stateDir = "${join(home.path, 'state')}"`,
    ].join('\n'),
  );

  const { code, stderr } = await invoke(['run'], {
    cwd: elsewhere.path,
    env: { HOME: home.path },
  });

  expect(stderr).toContain('Sampling server-1 every 15 seconds for http://heimdall.example:8080/');
  expect(code).toBe(130);
});

test('run settings from the environment override the configuration file', async () => {
  await using dir = await tempStateDir();
  const configFile = join(dir.path, 'collector.json');
  await writeFile(
    configFile,
    JSON.stringify({
      hub: 'http://a.example/',
      stateDir: dir.path,
      system: 'server-1',
      token: 't',
    }),
  );

  const { stderr } = await startAndStop(['run', '--config', configFile], {
    HEIMDALL_SYSTEM: 'server-2',
  });

  expect(stderr).toContain('Sampling server-2 every');
});

test('run without a Hub is a usage error that names the option', async () => {
  await using dir = await tempStateDir();
  const { code, stderr } = await startAndStop([
    'run',
    '--system',
    'server-1',
    '--token',
    't',
    '--state-dir',
    dir.path,
  ]);

  expect(stderr).toContain('--hub');
  expect(code).toBe(2);
});

test.each([
  ['a System outside Fleet names', ['--system', 'LAPTOP_1', '--hub', 'http://h.example/']],
  ['a Hub that is not an http URL', ['--system', 'server-1', '--hub', 'ftp://h.example/']],
])('run with %s is a usage error', async (_, settings) => {
  await using dir = await tempStateDir();
  const { code } = await startAndStop([
    'run',
    ...settings,
    '--token',
    't',
    '--state-dir',
    dir.path,
  ]);

  expect(code).toBe(2);
});
