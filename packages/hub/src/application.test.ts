import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { app } from './application.ts';
import { testDatabase } from './testing/postgres.ts';
import { versionLine } from './version.ts';

const LISTENING = /Listening on (?<url>http:\/\/\S+)/u;

// Runs the Hub command line in-process and captures what it prints. Once `serve`
// prints the address it listens on, `whileServing` runs against that address and
// the run is cancelled; a safety timeout cancels it after a few seconds anyway.
const invoke = async (
  argv: string[],
  { whileServing }: { whileServing?: (hub: URL) => Promise<void> } = {},
) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 5000);
  let printed = '';
  let serving: Promise<void> | undefined;
  stderr.on('data', (chunk: Buffer) => {
    printed += chunk.toString();
    const url = LISTENING.exec(printed)?.groups?.url;
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
  // Loom sets process.exitCode even for an injected host; keep it off the test runner.
  const runnerExitCode = process.exitCode;
  let code: number;
  try {
    code = await app.run({ host: { argv, env: {}, stderr, stdout }, signal: controller.signal });
    await serving;
  } finally {
    process.exitCode = runnerExitCode;
    clearTimeout(safety);
  }
  stdout.end();
  stderr.end();
  return { code, stderr: printed, stdout: await text(stdout) };
};

// A configuration file in a fresh directory that removes itself when disposed.
const configFile = async (lines: string[]) => {
  const dir = await mkdtemp(join(tmpdir(), 'heimdall-hub-'));
  const path = join(dir, 'hub.toml');
  await writeFile(path, lines.join('\n'));
  return { path, [Symbol.asyncDispose]: () => rm(dir, { force: true, recursive: true }) };
};

test('--version prints the version line Fleet compares and exits 0', async () => {
  const { code, stderr, stdout } = await invoke(['--version']);
  expect(stdout).toBe(`${versionLine()}\n`);
  expect(stderr).toBe('');
  expect(code).toBe(0);
});

test('a bare invocation is a usage error that names serve', async () => {
  const { code, stderr, stdout } = await invoke([]);
  expect(stdout).toBe('');
  expect(stderr).toContain('serve');
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
  const { code, stderr } = await invoke(['serve', 'now']);
  expect(stderr).toContain('accepts no arguments');
  expect(code).toBe(2);
});

test('serve migrates the database, ingests Reports, and lists Systems', async () => {
  await using db = await testDatabase();
  await using config = await configFile([
    `database = "${db.url.href}"`,
    'host = "127.0.0.1"',
    'port = 0',
    'tokens = ["db-mbp=mbp-s3cret"]',
  ]);
  let ingested = 0;
  let html = '';

  const { code, stderr } = await invoke(['serve', '--config', config.path], {
    whileServing: async (hub) => {
      const response = await fetch(new URL('api/v1/reports', hub), {
        body: JSON.stringify({
          collector: { arch: 'arm64', platform: 'darwin', version: '0.1.0' },
          samples: [sample(Date.now())],
          schemaVersion: REPORT_SCHEMA_VERSION,
          sentAt: Date.now(),
          system: 'db-mbp',
        }),
        headers: { authorization: 'Bearer mbp-s3cret', 'content-type': 'application/json' },
        method: 'POST',
      });
      ingested = response.status;
      html = await (await fetch(hub)).text();
    },
  });

  expect(ingested).toBe(200);
  expect(html).toContain('db-mbp');
  expect(stderr).not.toContain('mbp-s3cret');
  expect(code).toBe(130);
});

test('serve without a database is a usage error that names the option', async () => {
  const { code, stderr } = await invoke(['serve', '--token', 'db-mbp=t']);

  expect(stderr).toContain('--database');
  expect(code).toBe(2);
});

test('serve with a token entry that names no System is a usage error', async () => {
  const { code, stderr } = await invoke([
    'serve',
    '--database',
    'postgres://localhost/heimdall',
    '--token',
    'just-a-token',
  ]);

  expect(stderr).toContain('system=token');
  expect(code).toBe(2);
});

test('serve refuses two Systems that share a token', async () => {
  const { code, stderr } = await invoke([
    'serve',
    '--database',
    'postgres://localhost/heimdall',
    '--token',
    'asgard=same',
    '--token',
    'db-mbp=same',
  ]);

  expect(stderr).toContain('asgard and db-mbp share a token');
  expect(code).not.toBe(0);
});
