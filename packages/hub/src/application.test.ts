import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { app } from './application.ts';
import { migrate } from './migrations.ts';
import { storeReport } from './store.ts';
import { testDatabase } from './testing/postgres.ts';
import { versionLine } from './version.ts';

const LISTENING = /Listening on (?<url>http:\/\/\S+)/u;

// Runs the Hub command line in-process and captures what it prints. Once `serve`
// prints the address it listens on, `whileServing` runs against that address and
// the run is cancelled; a safety timeout cancels it after a few seconds anyway.
const invoke = async (
  argv: string[],
  {
    cwd,
    env = {},
    whileServing,
  }: {
    cwd?: string;
    env?: Record<string, string>;
    whileServing?: (hub: URL) => Promise<void>;
  } = {},
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
    code = await app.run({
      host: { argv, env, stderr, stdout, ...(cwd === undefined ? {} : { cwd }) },
      signal: controller.signal,
    });
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
    'tokens = ["laptop-1=laptop-s3cret"]',
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
          system: 'laptop-1',
        }),
        headers: { authorization: 'Bearer laptop-s3cret', 'content-type': 'application/json' },
        method: 'POST',
      });
      ingested = response.status;
      html = await (await fetch(hub)).text();
    },
  });

  expect(ingested).toBe(200);
  expect(html).toContain('laptop-1');
  expect(stderr).not.toContain('laptop-s3cret');
  expect(code).toBe(130);
});

// A database that already holds a 20-day-old sample for laptop-1, which a
// prune deletes. The migrations are applied, so `serve` finds nothing to do.
const databaseWithOldSample = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  const now = Date.now();
  await storeReport(db.sql, {
    receivedAt: now,
    report: {
      collector: { arch: 'arm64', platform: 'darwin', version: '0.1.0' },
      samples: [sample(now - 20 * 86_400_000)],
      schemaVersion: REPORT_SCHEMA_VERSION,
      sentAt: now,
      system: 'laptop-1',
    },
  });
  return db;
};

const serveArgs = (config: { path: string }) => ['serve', '--config', config.path];

test('serve prunes old Vitals as it starts, and says nothing about it', async () => {
  await using db = await databaseWithOldSample();
  await using config = await configFile([
    `database = "${db.url.href}"`,
    'host = "127.0.0.1"',
    'port = 0',
    'tokens = ["laptop-1=laptop-s3cret"]',
  ]);

  const { code, stderr } = await invoke(serveArgs(config));

  const remaining = await db.sql`SELECT count(*)::int AS n FROM vitals_samples`;
  expect(remaining[0].n).toBe(0);
  expect(stderr).not.toContain('prune');
  expect(code).toBe(130);
});

test('serve warns once when a prune fails, and keeps serving', async () => {
  await using db = await databaseWithOldSample();
  await db.sql`
    CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'delete refused'; END $$
  `;
  await db.sql`
    CREATE TRIGGER refuse BEFORE DELETE ON vitals_samples
    FOR EACH ROW EXECUTE FUNCTION refuse_delete()
  `;
  await using config = await configFile([
    `database = "${db.url.href}"`,
    'host = "127.0.0.1"',
    'port = 0',
    'tokens = ["laptop-1=laptop-s3cret"]',
  ]);
  let html = '';

  const { code, stderr } = await invoke(serveArgs(config), {
    whileServing: async (hub) => {
      html = await (await fetch(hub)).text();
    },
  });

  expect(stderr.match(/Could not prune old Vitals: .*delete refused/gu)).toHaveLength(1);
  expect(html).toContain('Heimdall');
  expect(code).toBe(130);
});

test('serve finds the configuration file under ~/.config/heimdall/ when --config is absent', async () => {
  await using db = await testDatabase();
  const home = await mkdtemp(join(tmpdir(), 'heimdall-hub-home-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'heimdall-hub-cwd-'));
  try {
    await mkdir(join(home, '.config', 'heimdall'), { recursive: true });
    await writeFile(
      join(home, '.config', 'heimdall', 'hub.toml'),
      [
        `database = "${db.url.href}"`,
        'host = "127.0.0.1"',
        'port = 0',
        'tokens = ["laptop-1=laptop-s3cret"]',
      ].join('\n'),
    );
    let html = '';

    const { code } = await invoke(['serve'], {
      cwd: elsewhere,
      env: { HOME: home },
      whileServing: async (hub) => {
        html = await (await fetch(hub)).text();
      },
    });

    expect(html).toContain('Heimdall');
    expect(code).toBe(130);
  } finally {
    await rm(home, { force: true, recursive: true });
    await rm(elsewhere, { force: true, recursive: true });
  }
});

test('serve without a database is a usage error that names the option', async () => {
  const { code, stderr } = await invoke(['serve', '--token', 'laptop-1=t']);

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
    'server-1=same',
    '--token',
    'laptop-1=same',
  ]);

  expect(stderr).toContain('server-1 and laptop-1 share a token');
  expect(code).not.toBe(0);
});

test('serve names the database as the problem when it cannot reach it', async () => {
  const { code, stderr } = await invoke([
    'serve',
    '--database',
    'postgres://heimdall:db-s3cret@127.0.0.1:1/heimdall',
    '--token',
    'laptop-1=t',
  ]);

  expect(stderr).toContain('Could not prepare the database');
  expect(stderr).not.toContain('db-s3cret');
  expect(code).toBe(1);
});
