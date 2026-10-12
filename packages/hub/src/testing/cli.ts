import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import type { Host } from '@loomcli/core';

import { app } from '../application.ts';

const LISTENING = /Listening on (?<url>http:\/\/\S+)/u;

// Runs the Hub command line in-process and captures what it prints, stdout as
// text and as the bytes written. Once `serve` logs the address it listens on,
// `whileServing` runs against that address and the run is cancelled; a safety
// timeout cancels it after a few seconds anyway. HOME is a fresh directory
// unless `env` names one, so `serve` never rotates a real log. `terminal`
// stands in for the process's own, so output does not depend on where the
// tests run.
export const invoke = async (
  argv: string[],
  {
    cwd,
    env = {},
    terminal,
    whileServing,
  }: {
    cwd?: string;
    env?: Record<string, string>;
    terminal?: Host['terminal'];
    whileServing?: (hub: URL) => Promise<void>;
  } = {},
) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 5000);
  const home = await mkdtemp(join(tmpdir(), 'heimdall-hub-home-'));
  const written: Buffer[] = [];
  let logged = '';
  let serving: Promise<void> | undefined;
  stdout.on('data', (chunk: Buffer) => {
    written.push(chunk);
    logged += chunk.toString();
    const url = LISTENING.exec(logged)?.groups?.url;
    if (url !== undefined && serving === undefined) {
      serving = (async () => {
        try {
          await whileServing?.(new URL(url));
        } finally {
          controller.abort();
        }
      })();
    }
  });
  const errors = text(stderr);
  // Loom sets process.exitCode even for an injected host; keep it off the test runner.
  // Bun ignores assigning undefined, so an unset code is restored as 0.
  const runnerExitCode = process.exitCode;
  let code: number;
  try {
    code = await app.run({
      host: {
        argv,
        env: { HOME: home, ...env },
        stderr,
        stdout,
        ...(cwd === undefined ? {} : { cwd }),
        ...(terminal === undefined ? {} : { terminal }),
      },
      signal: controller.signal,
    });
    await serving;
  } finally {
    process.exitCode = runnerExitCode ?? 0;
    clearTimeout(safety);
    await rm(home, { force: true, recursive: true });
  }
  stdout.end();
  stderr.end();
  return { bytes: Buffer.concat(written), code, stderr: await errors, stdout: logged };
};

// A configuration file in a fresh directory that removes itself when disposed.
export const configFile = async (lines: string[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'heimdall-hub-'));
  const path = join(dir, 'hub.toml');
  await writeFile(path, lines.join('\n'));
  return { path, [Symbol.asyncDispose]: () => rm(dir, { force: true, recursive: true }) };
};

// The Hub's configuration file for the database `db`, listening on a free
// port, with `database` lines added to its `[database]` table.
export const hubConfig = (db: { url: URL }, database: string[] = []) =>
  configFile([
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
    ...database,
  ]);

export const configArgs = (config: { path: string }) => ['--config', config.path];
