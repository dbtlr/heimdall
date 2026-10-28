import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mockProcess } from '@loomcli/testing';
import type { MockTerminal } from '@loomcli/testing';

import { app } from '../application.ts';

const LISTENING = /Listening on (?<url>http:\/\/\S+)/u;
const POLL_MS = 10;

// Runs the Hub command line in-process and captures what it prints, stdout as
// text and as the bytes written. Once `serve` logs the address it listens on,
// `whileServing` runs against that address and the run is cancelled; a safety
// timeout cancels it after a few seconds anyway. HOME is a fresh directory
// unless `env` names one, so `serve` never rotates a real log. `terminal`
// stands in for the process's own, so output does not depend on where the
// tests run; without it, no stream is a terminal.
export const invoke = async (
  argv: string[],
  {
    cwd = process.cwd(),
    env = {},
    terminal,
    whileServing,
  }: {
    cwd?: string;
    env?: Record<string, string>;
    terminal?: MockTerminal | undefined;
    whileServing?: (hub: URL) => Promise<void>;
  } = {},
) => {
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 5000);
  const home = await mkdtemp(join(tmpdir(), 'heimdall-hub-home-'));
  const mock = mockProcess({
    argv,
    cwd,
    env: { HOME: home, ...env },
    ...(terminal === undefined ? {} : { terminal }),
  });
  let serving: Promise<void> | undefined;
  // The mock records output without events, so poll it for the address.
  const watch = setInterval(() => {
    const url = LISTENING.exec(mock.stdout.text)?.groups?.url;
    if (url !== undefined && serving === undefined) {
      serving = (async () => {
        try {
          await whileServing?.(new URL(url));
        } finally {
          controller.abort();
        }
      })();
    }
  }, POLL_MS);
  try {
    const code = await app.run({ process: mock, signal: controller.signal });
    await serving;
    const { text } = mock.stdout;
    return { bytes: Buffer.from(text), code, stderr: mock.stderr.text, stdout: text };
  } finally {
    clearInterval(watch);
    clearTimeout(safety);
    await rm(home, { force: true, recursive: true });
  }
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
