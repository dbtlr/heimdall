import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { app } from './application.ts';
import { migrate } from './migrations.ts';
import { storeReport } from './store.ts';
import { gzip } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';
import { storeToken } from './tokens.ts';
import { appendChunk, openGeneration } from './transcripts.ts';
import { versionLine } from './version.ts';

const LISTENING = /Listening on (?<url>http:\/\/\S+)/u;

// Runs the Hub command line in-process and captures what it prints. Once `serve`
// logs the address it listens on, `whileServing` runs against that address and
// the run is cancelled; a safety timeout cancels it after a few seconds anyway.
// HOME is a fresh directory unless `env` names one, so `serve` never rotates a
// real log.
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
  const home = await mkdtemp(join(tmpdir(), 'heimdall-hub-home-'));
  let logged = '';
  let serving: Promise<void> | undefined;
  stdout.on('data', (chunk: Buffer) => {
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
      },
      signal: controller.signal,
    });
    await serving;
  } finally {
    process.exitCode = runnerExitCode;
    clearTimeout(safety);
    await rm(home, { force: true, recursive: true });
  }
  stdout.end();
  stderr.end();
  return { code, stderr: await errors, stdout: logged };
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

// The Hub's configuration file for the database `db`, listening on a free port.
const hubConfig = (db: { url: URL }) =>
  configFile(['host = "127.0.0.1"', 'port = 0', '[database]', `url = "${db.url.href}"`]);

const configArgs = (config: { path: string }) => ['--config', config.path];

const SHOWN_CODE =
  /Pairing code for (?<system>\S+): (?<code>[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\n/u;

test('pair, before serve has ever run, prints a code for the System and when it expires', async () => {
  await using db = await testDatabase();
  await using config = await hubConfig(db);
  const before = Date.now();

  const { code, stderr, stdout } = await invoke(['pair', 'laptop-1', ...configArgs(config)]);

  expect(stderr).toBe('');
  expect(code).toBe(0);
  const shown = SHOWN_CODE.exec(stdout)?.groups;
  expect(shown?.system).toBe('laptop-1');
  const expiry = /expires at (?<at>\S+Z)\./u.exec(stdout)?.groups?.at ?? '';
  expect(Date.parse(expiry) - before).toBeGreaterThanOrEqual(10 * 60_000);
  expect(Date.parse(expiry) - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  expect(stdout).toContain(`On laptop-1, run: heimdall-collector pair ${shown?.code ?? ''}`);
});

test('a System paired with pair redeems its code from serve, and its token ingests Reports', async () => {
  await using db = await testDatabase();
  await using config = await hubConfig(db);
  const issued = await invoke(['pair', 'laptop-1', ...configArgs(config)]);
  const shown = SHOWN_CODE.exec(issued.stdout)?.groups?.code ?? '';
  let paired: { system?: string; token?: string } = {};
  let ingested = 0;
  let html = '';

  const { code, stderr, stdout } = await invoke(['serve', ...configArgs(config)], {
    whileServing: async (hub) => {
      const redeemed = await fetch(new URL('api/v1/pair', hub), {
        body: JSON.stringify({ code: shown.toLowerCase() }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });
      paired = (await redeemed.json()) as typeof paired;
      const response = await fetch(new URL('api/v1/reports', hub), {
        body: JSON.stringify({
          collector: { arch: 'arm64', platform: 'darwin', version: '0.1.0' },
          samples: [sample(Date.now())],
          schemaVersion: REPORT_SCHEMA_VERSION,
          sentAt: Date.now(),
          system: 'laptop-1',
        }),
        headers: {
          authorization: `Bearer ${paired.token ?? ''}`,
          'content-type': 'application/json',
        },
        method: 'POST',
      });
      ingested = response.status;
      html = await (await fetch(hub)).text();
    },
  });

  expect(paired.system).toBe('laptop-1');
  expect(ingested).toBe(200);
  expect(html).toContain('laptop-1');
  expect(stdout).toContain('for 0 Systems.');
  expect(stdout).not.toContain(paired.token ?? 'no token');
  expect(stderr).toBe('');
  expect(code).toBe(130);
});

test('serve counts the paired Systems as it starts', async () => {
  await using db = await testDatabase();
  await migrate(db.sql);
  await storeToken(db.sql, { pairedAt: Date.now(), system: 'laptop-1', token: 'laptop-token' });
  await storeToken(db.sql, { pairedAt: Date.now(), system: 'server-1', token: 'server-token' });
  await using config = await hubConfig(db);

  const { stdout } = await invoke(['serve', ...configArgs(config)]);

  expect(stdout).toMatch(/Listening on http:\/\/127\.0\.0\.1:\d+\/ for 2 Systems\.\n/u);
});

test('pair for a System that is paired says its token works until the new code is redeemed', async () => {
  await using db = await testDatabase();
  await migrate(db.sql);
  await storeToken(db.sql, { pairedAt: Date.now(), system: 'laptop-1', token: 'laptop-token' });
  await using config = await hubConfig(db);

  const { code, stdout } = await invoke(['pair', 'laptop-1', ...configArgs(config)]);

  expect(stdout).toContain(
    'laptop-1 is paired already. Its token works until this code is redeemed.',
  );
  expect(code).toBe(0);
});

test.each([['LAPTOP_1'], ['laptop-'], ['laptop.example']])(
  'pair %p, which is no System name, is a usage error',
  async (system) => {
    const { code, stderr } = await invoke(['pair', system, '--database', 'postgres://db/heimdall']);

    expect(stderr).toContain('Fleet System name');
    expect(code).toBe(2);
  },
);

test('pair without a System is a usage error', async () => {
  const { code } = await invoke(['pair', '--database', 'postgres://db/heimdall']);

  expect(code).toBe(2);
});

test('unpair revokes a paired System and says its history stays', async () => {
  await using db = await testDatabase();
  await migrate(db.sql);
  await storeToken(db.sql, { pairedAt: Date.now(), system: 'laptop-1', token: 'laptop-token' });
  await using config = await hubConfig(db);

  const { code, stdout } = await invoke(['unpair', 'laptop-1', ...configArgs(config)]);

  expect(stdout).toBe(
    'Unpaired laptop-1. Its token no longer authenticates Reports; its history stays.\n',
  );
  expect(code).toBe(0);
  expect((await invoke(['serve', ...configArgs(config)])).stdout).toContain('for 0 Systems.');
});

test('unpair of a System with only a pending code withdraws the code', async () => {
  await using db = await testDatabase();
  await using config = await hubConfig(db);
  await invoke(['pair', 'laptop-1', ...configArgs(config)]);

  const { code, stdout } = await invoke(['unpair', 'laptop-1', ...configArgs(config)]);

  expect(stdout).toBe('laptop-1 was not paired. Withdrew its pending Pairing code.\n');
  expect(code).toBe(0);
});

test('unpair of a System that is not paired says so and exits 1', async () => {
  await using db = await testDatabase();
  await using config = await hubConfig(db);

  const { code, stderr } = await invoke(['unpair', 'laptop-1', ...configArgs(config)]);

  expect(stderr).toContain('laptop-1 is not paired.');
  expect(code).toBe(1);
});

// A database holding one generation of laptop-1's transcripts, last uploaded
// on 2026-10-01.
const withTranscript = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  const now = Date.UTC(2026, 9, 1);
  const opened = await openGeneration(db.sql, {
    now,
    path: 'project/a.jsonl',
    source: 'claude-code',
    system: 'laptop-1',
  });
  const generation = opened.kind === 'opened' ? opened.generation : 0;
  const content = await gzip('{"type":"user"}\n');
  await appendChunk(db.sql, {
    content,
    generation,
    length: 16,
    now,
    offset: 0,
    system: 'laptop-1',
  });
  const live = async () =>
    (await db.sql`SELECT count(*)::int AS n FROM transcript_chunks`)[0] as { n: number };
  return { db, gzipped: content.byteLength, live };
};

test('transcripts delete removes the matching generations and says how much it removed', async () => {
  const { db, gzipped, live } = await withTranscript();
  await using _db = db;
  await using config = await hubConfig(db);

  const { code, stdout } = await invoke([
    'transcripts',
    'delete',
    '--system',
    'laptop-1',
    '--before',
    '2026-10-02',
    ...configArgs(config),
  ]);

  expect(stdout).toBe(`Deleted 1 generation of transcripts, ${String(gzipped)} gzipped bytes.\n`);
  expect(code).toBe(0);
  expect(await live()).toEqual({ n: 0 });
});

test('transcripts delete --dry-run says what it would remove and removes nothing', async () => {
  const { db, gzipped, live } = await withTranscript();
  await using _db = db;
  await using config = await hubConfig(db);

  const { code, stdout } = await invoke([
    'transcripts',
    'delete',
    '--source',
    'claude-code',
    '--dry-run',
    ...configArgs(config),
  ]);

  expect(stdout).toBe(
    `Would delete 1 generation of transcripts, ${String(gzipped)} gzipped bytes.\n`,
  );
  expect(code).toBe(0);
  expect(await live()).toEqual({ n: 1 });
});

// Every upload of laptop-1's transcript happened on 2026-10-01, so a date of
// that day keeps it: a generation is removed only when its last upload is
// before the start of the day, in UTC.
test('transcripts delete --before keeps a generation last uploaded on that day', async () => {
  const { db, live } = await withTranscript();
  await using _db = db;
  await using config = await hubConfig(db);

  const { stdout } = await invoke([
    'transcripts',
    'delete',
    '--before',
    '2026-10-01',
    ...configArgs(config),
  ]);

  expect(stdout).toBe('Deleted 0 generations of transcripts, 0 gzipped bytes.\n');
  expect(await live()).toEqual({ n: 1 });
});

test('transcripts delete without a filter refuses and deletes nothing', async () => {
  const { db, live } = await withTranscript();
  await using _db = db;
  await using config = await hubConfig(db);

  const { code, stderr } = await invoke(['transcripts', 'delete', ...configArgs(config)]);

  expect(stderr).toContain('--system, --source, or --before');
  expect(code).not.toBe(0);
  expect(await live()).toEqual({ n: 1 });
});

test('transcripts delete --before takes a calendar date', async () => {
  const { code } = await invoke(['transcripts', 'delete', '--before', 'last week']);

  expect(code).toBe(2);
});

test('pair and unpair read the database from HEIMDALL_DATABASE_URL', async () => {
  await using db = await testDatabase();

  const paired = await invoke(['pair', 'laptop-1'], {
    env: { HEIMDALL_DATABASE_URL: db.url.href },
  });
  const unpaired = await invoke(['unpair', 'laptop-1'], {
    env: { HEIMDALL_DATABASE_URL: db.url.href },
  });

  expect(paired.code).toBe(0);
  expect(unpaired.code).toBe(0);
});

test('pair names the database as the problem when it cannot reach it', async () => {
  const { code, stderr } = await invoke([
    'pair',
    'laptop-1',
    '--database',
    'postgres://heimdall:db-s3cret@127.0.0.1:1/heimdall',
  ]);

  expect(stderr).toContain('Could not reach the database');
  expect(stderr).not.toContain('db-s3cret');
  expect(code).toBe(1);
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
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
  ]);

  const { code, stderr, stdout } = await invoke(serveArgs(config));

  const remaining = await db.sql`SELECT count(*)::int AS n FROM vitals_samples`;
  expect(remaining[0].n).toBe(0);
  expect(stdout).not.toContain('prune');
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
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
  ]);
  let html = '';

  const { code, stdout } = await invoke(serveArgs(config), {
    whileServing: async (hub) => {
      html = await (await fetch(hub)).text();
    },
  });

  expect(stdout.match(/Could not prune old Vitals: .*delete refused/gu)).toHaveLength(1);
  expect(html).toContain('Heimdall');
  expect(code).toBe(130);
});

const TIMESTAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S/u;

// A fatal line that starts with its time, like every runtime line.
const timestampedFatal = (message: string) =>
  new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z [^\\n]*${message}`, 'u');

test('serve starts every runtime line with its ISO 8601 UTC time', async () => {
  await using db = await databaseWithOldSample();
  await using config = await configFile([
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
  ]);

  const { stdout } = await invoke(serveArgs(config));

  const lines = stdout.trimEnd().split('\n');
  expect(lines.some((line) => line.includes('Listening on'))).toBe(true);
  for (const line of lines) {
    expect(line).toMatch(TIMESTAMPED);
  }
});

test('serve rotates a log from before timestamps as it starts', async () => {
  await using db = await testDatabase();
  await using config = await configFile([
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
  ]);
  const home = await mkdtemp(join(tmpdir(), 'heimdall-hub-home-'));
  const logDir = join(home, '.local', 'state', 'heimdall');
  try {
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'hub.log'), 'Listening on http://127.0.0.1:8080/.\n');

    const { code } = await invoke(serveArgs(config), { env: { HOME: home } });

    expect(await readFile(join(logDir, 'hub.log.1'), 'utf8')).toBe(
      'Listening on http://127.0.0.1:8080/.\n',
    );
    expect(await readFile(join(logDir, 'hub.log'), 'utf8')).toBe('');
    expect(code).toBe(130);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
});

test('service install refuses to run from source', async () => {
  const { code, stderr } = await invoke(['service', 'install', '--port', '9090']);

  expect(stderr).toContain('not a compiled binary');
  expect(code).toBe(1);
});

test("service status reports this binary's unit and exits 0", async () => {
  const { code, stdout } = await invoke(['service', 'status']);

  expect(stdout).toStartWith('com.dbtlr.heimdall.hub: ');
  expect(stdout).toContain('~/.local/state/heimdall/hub.log');
  expect(code).toBe(0);
});

test('serve finds the configuration file under ~/.config/heimdall/ when --config is absent', async () => {
  await using db = await testDatabase();
  const home = await mkdtemp(join(tmpdir(), 'heimdall-hub-home-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'heimdall-hub-cwd-'));
  try {
    await mkdir(join(home, '.config', 'heimdall'), { recursive: true });
    await writeFile(
      join(home, '.config', 'heimdall', 'hub.toml'),
      ['host = "127.0.0.1"', 'port = 0', '[database]', `url = "${db.url.href}"`].join('\n'),
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
  const { code, stderr } = await invoke(['serve']);

  expect(stderr).toContain('--database');
  expect(code).toBe(2);
});

// Before pairing, the database URL was a top-level key (ADR-0009).
test('serve reads the database only from [database] url, not a top-level database key', async () => {
  await using db = await testDatabase();
  await using config = await configFile([`database = "${db.url.href}"`, 'port = 0']);

  const { code, stderr } = await invoke(serveArgs(config));

  expect(stderr).toContain('--database');
  expect(code).toBe(2);
});

test('serve takes no --token: Systems pair instead', async () => {
  const { code, stderr } = await invoke([
    'serve',
    '--database',
    'postgres://localhost/heimdall',
    '--token',
    'laptop-1=t',
  ]);

  expect(stderr).toContain('--token');
  expect(code).toBe(2);
});

test('serve names the database as the problem when it cannot reach it', async () => {
  const { code, stderr } = await invoke([
    'serve',
    '--database',
    'postgres://heimdall:db-s3cret@127.0.0.1:1/heimdall',
  ]);

  expect(stderr).toMatch(timestampedFatal('Could not prepare the database'));
  expect(stderr).not.toContain('db-s3cret');
  expect(code).toBe(1);
});
