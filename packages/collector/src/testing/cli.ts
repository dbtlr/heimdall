import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import { app } from '../application.ts';
import { tempStateDir } from './fixtures.ts';

// Runs the Collector command line in-process and captures what it prints. A run
// that starts collecting is cancelled once its log shows it started, or after a
// few seconds, so a `run` test ends either way. HOME is a fresh directory unless
// `env` names one, so `run` never rotates a real log.
export const invoke = async (
  argv: string[],
  { cwd, env = {} }: { cwd?: string; env?: Record<string, string> } = {},
) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 5000);
  await using home = await tempStateDir();
  let logged = '';
  stdout.on('data', (chunk: Buffer) => {
    logged += chunk.toString();
    if (logged.includes('Sampling ')) {
      controller.abort();
    }
  });
  const errors = text(stderr);
  // Loom sets process.exitCode even for an injected host; keep it off the test runner.
  const runnerExitCode = process.exitCode;
  let code: number;
  try {
    code = await app.run({
      host: {
        argv,
        env: { HOME: home.path, ...env },
        stderr,
        stdout,
        ...(cwd === undefined ? {} : { cwd }),
      },
      signal: controller.signal,
    });
  } finally {
    process.exitCode = runnerExitCode;
    clearTimeout(safety);
  }
  stdout.end();
  stderr.end();
  return { code, stderr: await errors, stdout: logged };
};

// A token of the shape the Hub issues: 32 bytes in base64url.
export const TOKEN = 'q8Yv1o3Jx0ZtBf6c2W9kLr4uPn5sEa7hGd_Ui-HmTwQ';

// Writes `identity.json` into `stateDir` as `pair` leaves it after pairing
// with `hub`, an origin, or with `mode`,
// creating the directory private to its owner, as `pair` does.
export const givenIdentity = async (
  stateDir: string,
  { hub = 'http://h.example', mode = 0o600, system = 'server-1', token = TOKEN } = {},
) => {
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  const path = join(stateDir, 'identity.json');
  await writeFile(path, JSON.stringify({ hub, system, token }), { mode });
  await chmod(path, mode);
  return path;
};
