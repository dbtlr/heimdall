import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { mockProcess } from '@loomcli/testing';

import { app } from '../application.ts';
import { tempStateDir } from './fixtures.ts';

const POLL_MS = 10;

// Runs the Collector command line in-process and captures what it prints. A run
// that starts collecting is cancelled once its log shows it started, or after a
// few seconds, so a `run` test ends either way. HOME is a fresh directory unless
// `env` names one, so `run` never rotates a real log. `stdin` is what a pipe
// delivers (empty when omitted), and `stdinIsTerminal` makes standard input a
// terminal.
export const invoke = async (
  argv: string[],
  {
    cwd = process.cwd(),
    env = {},
    stdin,
    stdinIsTerminal = false,
  }: {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string | Uint8Array;
    stdinIsTerminal?: boolean;
  } = {},
) => {
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 5000);
  await using home = await tempStateDir();
  const mock = mockProcess({
    argv,
    cwd,
    env: { HOME: home.path, ...env },
    ...(stdinIsTerminal
      ? { terminal: { columns: 80, keys: [], rows: 24, streams: [] } }
      : { stdin: typeof stdin === 'string' ? stdin : '' }),
  });
  // The mock takes piped text only; bytes that are not text go in as the stream itself.
  if (stdin instanceof Uint8Array) {
    Object.defineProperty(mock, 'stdin', {
      value: Object.assign(Readable.from([stdin]), { isRaw: false, isTTY: false }),
    });
  }
  // The mock records output without events, so poll it for the start of collecting.
  const watch = setInterval(() => {
    if (mock.stdout.text.includes('Sampling ')) {
      controller.abort();
    }
  }, POLL_MS);
  try {
    const code = await app.run({ process: mock, signal: controller.signal });
    return { code, stderr: mock.stderr.text, stdout: mock.stdout.text };
  } finally {
    clearInterval(watch);
    clearTimeout(safety);
  }
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
