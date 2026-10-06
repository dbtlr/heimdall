import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import { app } from './application.ts';
import { versionLine } from './version.ts';

// Runs the Hub command line in-process and captures what it prints.
const invoke = async (argv: string[]) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Loom sets process.exitCode even for an injected host; keep it off the test runner.
  const runnerExitCode = process.exitCode;
  let code: number;
  try {
    code = await app.run({ host: { argv, stderr, stdout } });
  } finally {
    process.exitCode = runnerExitCode;
  }
  stdout.end();
  stderr.end();
  return { code, stderr: await text(stderr), stdout: await text(stdout) };
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
  expect(stderr).toContain('A command is required.');
  expect(stderr).toContain('heimdall-hub --help');
  expect(code).toBe(2);
});

test('an unknown option is a usage error', async () => {
  const { code, stderr, stdout } = await invoke(['--bogus']);
  expect(stdout).toBe('');
  expect(stderr).toContain('--bogus');
  expect(code).toBe(2);
});

test('a stray argument is a usage error', async () => {
  const { code, stderr, stdout } = await invoke(['report']);
  expect(stdout).toBe('');
  expect(stderr).toContain('accepts no arguments');
  expect(code).toBe(2);
});
