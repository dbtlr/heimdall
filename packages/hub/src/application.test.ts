import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPORT_SCHEMA_VERSION } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';
import { assertAssembles } from '@loomcli/testing';
import type { SQL } from 'bun';

import packageJson from '../package.json' with { type: 'json' };
import { app } from './application.ts';
import { raise } from './conditions.ts';
import { storeReport } from './store.ts';
import { configArgs, configFile, hubConfig, invoke } from './testing/cli.ts';
import { gzip } from './testing/hub.ts';
import { migratedDatabase, testDatabase } from './testing/postgres.ts';
import { storeToken } from './tokens.ts';
import { appendChunk, openGeneration } from './transcripts.ts';

test('the application assembles', () => {
  assertAssembles(app);
});

test('--version names the Hub release and the Report schema it accepts, and exits 0', async () => {
  const { code, stderr, stdout } = await invoke(['--version']);
  expect(stdout).toMatch(/^heimdall-hub v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)? \(Report schema v\d+\)\n$/);
  expect(stdout).toBe(
    `heimdall-hub v${packageJson.version} (Report schema v${REPORT_SCHEMA_VERSION})\n`,
  );
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
  await using db = await migratedDatabase();
  await using config = await hubConfig(db);
  const issued = await invoke(['pair', 'laptop-1', ...configArgs(config)]);
  const shown = SHOWN_CODE.exec(issued.stdout)?.groups?.code ?? '';
  let paired: { system?: string; token?: string } = {};
  let ingested = 0;

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
    },
  });

  expect(paired.system).toBe('laptop-1');
  expect(ingested).toBe(200);
  const stored: { system: string }[] = await db.sql`SELECT system FROM vitals_samples`;
  expect(stored).toEqual([{ system: 'laptop-1' }]);
  expect(stdout).toContain('for 0 Systems.');
  expect(stdout).not.toContain(paired.token ?? 'no token');
  expect(stderr).toBe('');
  expect(code).toBe(130);
});

test('serve counts the paired Systems as it starts', async () => {
  await using db = await migratedDatabase();
  await storeToken(db.sql, { pairedAt: Date.now(), system: 'laptop-1', token: 'laptop-token' });
  await storeToken(db.sql, { pairedAt: Date.now(), system: 'server-1', token: 'server-token' });
  await using config = await hubConfig(db);

  const { stdout } = await invoke(['serve', ...configArgs(config)]);

  expect(stdout).toMatch(/Listening on http:\/\/127\.0\.0\.1:\d+\/ for 2 Systems\.\n/u);
});

test('serve on a port already in use says which address it could not listen on, and exits 1', async () => {
  await using db = await migratedDatabase();
  await using config = await hubConfig(db);
  const taken = Bun.serve({ fetch: () => new Response(), hostname: '127.0.0.1', port: 0 });
  try {
    const { code, stderr } = await invoke([
      'serve',
      ...configArgs(config),
      '--port',
      String(taken.port),
    ]);

    expect(stderr).toMatch(
      new RegExp(`\\S+Z Could not listen on 127\\.0\\.0\\.1:${String(taken.port)}: \\S`, 'u'),
    );
    expect(code).toBe(1);
  } finally {
    await taken.stop();
  }
});

test('pair for a System that is paired says its token works until the new code is redeemed', async () => {
  await using db = await migratedDatabase();
  await storeToken(db.sql, { pairedAt: Date.now(), system: 'laptop-1', token: 'laptop-token' });
  await using config = await hubConfig(db);

  const { code, stdout } = await invoke(['pair', 'laptop-1', ...configArgs(config)]);

  expect(stdout).toContain(
    'laptop-1 is paired already. Its token works until this code is redeemed.',
  );
  expect(code).toBe(0);
});

test.each([['LAPTOP_1']])('pair %p, which is no System name, is a usage error', async (system) => {
  const { code, stderr } = await invoke(['pair', system, '--database', 'postgres://db/heimdall']);

  expect(stderr).toContain('Fleet System name');
  expect(code).toBe(2);
});

test('unpair revokes a paired System and says its history stays', async () => {
  await using db = await migratedDatabase();
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
  await using db = await migratedDatabase();
  await using config = await hubConfig(db);
  await invoke(['pair', 'laptop-1', ...configArgs(config)]);

  const { code, stdout } = await invoke(['unpair', 'laptop-1', ...configArgs(config)]);

  expect(stdout).toBe('laptop-1 was not paired. Withdrew its pending Pairing code.\n');
  expect(code).toBe(0);
});

test('unpair of a System that is not paired says so and exits 1', async () => {
  await using db = await migratedDatabase();
  await using config = await hubConfig(db);

  const { code, stderr } = await invoke(['unpair', 'laptop-1', ...configArgs(config)]);

  expect(stderr).toContain('laptop-1 is not paired.');
  expect(code).toBe(1);
});

// A database holding one generation of laptop-1's transcripts, last uploaded
// at `now`, by default the start of 2026-10-01 in UTC.
const withTranscript = async (now = Date.UTC(2026, 9, 1)) => {
  const db = await migratedDatabase();
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

// Tokyo's midnight on 2026-10-02 is 15:00 UTC on 2026-10-01, before the upload.
test('transcripts delete --before reads the date in UTC, whatever the local time zone', async () => {
  const { db, live } = await withTranscript(Date.UTC(2026, 9, 1, 20));
  await using _db = db;
  await using config = await hubConfig(db);
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Tokyo';
  try {
    await invoke(['transcripts', 'delete', '--before', '2026-10-02', ...configArgs(config)]);
  } finally {
    if (zone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = zone;
    }
  }

  expect(await live()).toEqual({ n: 0 });
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
  await using db = await migratedDatabase();

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
  const db = await migratedDatabase();
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

test('serve prunes old Vitals and ended Service stops as it starts, and says nothing about it', async () => {
  await using db = await databaseWithOldSample();
  const old = new Date(Date.now() - 91 * 86_400_000);
  const recent = new Date();
  await db.sql`
    INSERT INTO service_stops (system, service, stopped_at, ongoing, restarts, sent_at, received_at)
    VALUES ('laptop-1', 'old', ${old}, false, 0, ${recent}, ${recent}),
           ('laptop-1', 'ongoing', ${old}, true, 0, ${recent}, ${recent}),
           ('laptop-1', 'recent', ${recent}, false, 0, ${recent}, ${recent})
  `;
  await using config = await configFile([
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
  ]);

  const { code, stderr, stdout } = await invoke(serveArgs(config));

  const remaining = await db.sql`SELECT count(*)::int AS n FROM vitals_samples`;
  expect(remaining[0].n).toBe(0);
  const stops: { service: string }[] =
    await db.sql`SELECT service FROM service_stops ORDER BY service`;
  expect(stops.map((row) => row.service)).toEqual(['ongoing', 'recent']);
  expect(stdout).not.toContain('prune');
  expect(stderr).not.toContain('prune');
  expect(code).toBe(130);
});

// A database where server-1 was paired an hour ago and never heard from, and a
// Hub last recorded listening `heardAgoMs` ago, having listened for two hours.
const databaseWithSilentSystem = async (heardAgoMs: number) => {
  const db = await migratedDatabase();
  await storeToken(db.sql, {
    pairedAt: Date.now() - 3_600_000,
    system: 'server-1',
    token: 'server-token',
  });
  await db.sql`
    UPDATE hub_listening SET
      heard_at = ${new Date(Date.now() - heardAgoMs)},
      listening_since = ${new Date(Date.now() - 7_200_000)}
  `;
  return db;
};

test('serve judges Conditions as it starts: a paired System never heard from is stale', async () => {
  await using db = await databaseWithSilentSystem(30_000);
  await using config = await configFile([
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
  ]);

  const { code, stderr } = await invoke(serveArgs(config));

  const open = await db.sql`
    SELECT system, kind FROM conditions WHERE cleared_at IS NULL
  `;
  expect(open.map((c: { kind: string; system: string }) => [c.system, c.kind])).toEqual([
    ['server-1', 'system_stale'],
  ]);
  expect(stderr).not.toContain('judge');
  expect(code).toBe(130);
});

test('serve back from an outage does not raise stale System for the time it was down', async () => {
  await using db = await databaseWithSilentSystem(3_600_000);
  await using config = await configFile([
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
  ]);

  const { code } = await invoke(serveArgs(config));

  const open: { kind: string }[] =
    await db.sql`SELECT kind FROM conditions WHERE cleared_at IS NULL`;
  expect(open).toEqual([]);
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
  let health = 0;

  const { code, stdout } = await invoke(serveArgs(config), {
    whileServing: async (hub) => {
      health = (await fetch(new URL('api/health', hub))).status;
    },
  });

  expect(
    stdout.match(/Could not prune old Vitals and Service stops: .*delete refused/gu),
  ).toHaveLength(1);
  expect(health).toBe(200);
  expect(code).toBe(130);
});

// A price overrides file in a fresh directory that removes itself when disposed.
const priceFile = async (contents: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'heimdall-prices-'));
  const path = join(dir, 'prices.json');
  await writeFile(path, contents);
  return { path, [Symbol.asyncDispose]: () => rm(dir, { force: true, recursive: true }) };
};

const OVERRIDE = JSON.stringify({
  prices: [
    { contextWindow: 100_000, input: 1, model: 'my-model', output: 2, validFrom: '2026-07-01' },
  ],
});

test('serve loads the bundled prices and the overrides file the configuration names', async () => {
  await using db = await migratedDatabase();
  await using prices = await priceFile(OVERRIDE);
  await using config = await configFile([
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    `url = "${db.url.href}"`,
    '[prices]',
    `overrides = "${prices.path}"`,
  ]);

  const { code, stderr } = await invoke(serveArgs(config));

  const rows: { n: number; source: string }[] = await db.sql`
    SELECT source, count(*)::int AS n FROM model_prices GROUP BY source ORDER BY source
  `;
  expect(rows.map((row) => row.source)).toEqual(['bundled', 'configured']);
  expect(rows.find((row) => row.source === 'bundled')?.n).toBeGreaterThan(0);
  expect(rows.find((row) => row.source === 'configured')?.n).toBe(1);
  expect(stderr).toBe('');
  expect(code).toBe(130);
});

test('serve takes the overrides file from the variable too', async () => {
  await using db = await migratedDatabase();
  await using prices = await priceFile(OVERRIDE);
  await using config = await hubConfig(db);

  await invoke(serveArgs(config), { env: { HEIMDALL_PRICE_OVERRIDES: prices.path } });

  const [row]: { n: number }[] = await db.sql`
    SELECT count(*)::int AS n FROM model_prices WHERE source = 'configured'
  `;
  expect(row?.n).toBe(1);
});

test('serve stops, naming the file, when the overrides file is not valid, before it touches the database', async () => {
  await using db = await testDatabase();
  await using prices = await priceFile('{"prices": [{"model": "m"}]}');
  await using config = await hubConfig(db);

  const { code, stderr } = await invoke(serveArgs(config), {
    env: { HEIMDALL_PRICE_OVERRIDES: prices.path },
  });

  expect(stderr).toContain('Could not read the price overrides in');
  expect(stderr).toContain('prices.json');
  expect(code).not.toBe(0);
  const tables = await db.sql`SELECT to_regclass('model_prices') AS found`;
  expect(tables[0].found).toBeNull();
});

const TIMESTAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S/u;

// A fatal line that starts with its time, like every runtime line.
const timestampedFatal = (message: string) =>
  new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z [^\\n]*${message}`, 'u');

test('serve stops with a timestamped fatal line, not a raw error, when the price table cannot load', async () => {
  await using db = await migratedDatabase();
  await db.sql`
    CREATE FUNCTION refuse_insert() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'insert refused'; END $$
  `;
  await db.sql`
    CREATE TRIGGER refuse BEFORE INSERT ON model_prices
    FOR EACH ROW EXECUTE FUNCTION refuse_insert()
  `;
  await using config = await hubConfig(db);

  const { code, stderr } = await invoke(serveArgs(config));

  expect(stderr).toMatch(timestampedFatal('Could not load the price table: .*insert refused'));
  expect(code).not.toBe(0);
});

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
  await using db = await migratedDatabase();
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
  await using db = await migratedDatabase();
  const home = await mkdtemp(join(tmpdir(), 'heimdall-hub-home-'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'heimdall-hub-cwd-'));
  try {
    await mkdir(join(home, '.config', 'heimdall'), { recursive: true });
    await writeFile(
      join(home, '.config', 'heimdall', 'hub.toml'),
      ['host = "127.0.0.1"', 'port = 0', '[database]', `url = "${db.url.href}"`].join('\n'),
    );
    let health = 0;

    const { code } = await invoke(['serve'], {
      cwd: elsewhere,
      env: { HOME: home },
      whileServing: async (hub) => {
        health = (await fetch(new URL('api/health', hub))).status;
      },
    });

    expect(health).toBe(200);
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
  await using config = await configFile([`database = "${UNREACHED_DATABASE.href}"`, 'port = 0']);

  const { code, stderr } = await invoke(serveArgs(config));

  expect(stderr).toContain('--database');
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

test('serve with a [delivery] section pushes an open alert to ntfy, and logs neither topic nor token', async () => {
  const received: unknown[] = [];
  const ntfy = Bun.serve({
    fetch: async (request) => {
      received.push(await request.json());
      return Response.json({ id: 'x' });
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  try {
    await using db = await migratedDatabase();
    await storeToken(db.sql, { pairedAt: Date.now(), system: 'server-1', token: 'server-token' });
    await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('server-1', now())`;
    await db.sql.begin((tx) =>
      raise(tx, {
        kind: 'service_down',
        now: new Date(),
        reason: 'nginx: inactive (dead).',
        subject: 'nginx',
        system: 'server-1',
      }),
    );
    await using config = await hubConfig(db, [
      '[delivery]',
      `url = "${ntfy.url.href}"`,
      'topic = "heimdall-x7Qp"',
      'token = "tk_s3cret"',
      'dashboard = "https://dashboard.example/"',
    ]);

    const { code, stderr, stdout } = await invoke(['serve', ...configArgs(config)], {
      whileServing: async () => {
        for (let tries = 0; received.length === 0 && tries < 100; tries += 1) {
          // oxlint-disable-next-line no-await-in-loop -- polls until the push arrives.
          await Bun.sleep(20);
        }
      },
    });

    expect(received).toEqual([
      expect.objectContaining({ title: 'Service down on server-1: nginx', topic: 'heimdall-x7Qp' }),
    ]);
    expect(stdout).toContain(`Delivering alerts through ${ntfy.url.host}.`);
    expect(`${stdout}${stderr}`).not.toContain('heimdall-x7Qp');
    expect(`${stdout}${stderr}`).not.toContain('tk_s3cret');
    expect(code).toBe(130);
  } finally {
    await ntfy.stop(true);
  }
});

test('serve refuses an invalid [delivery] section before it opens the database, naming the setting', async () => {
  await using config = await configFile([
    'host = "127.0.0.1"',
    'port = 0',
    '[database]',
    'url = "postgres://heimdall@127.0.0.1:1/heimdall"',
    '[delivery]',
    'url = "https://ntfy.example"',
    'topic = "not a topic"',
    'dashboard = "https://dashboard.example/"',
  ]);

  const { code, stderr } = await invoke(['serve', ...configArgs(config)]);

  expect(stderr).toContain('Invalid Hub delivery settings: delivery.topic');
  expect(stderr).not.toContain('not a topic');
  expect(stderr).not.toContain('database');
  expect(code).toBe(1);
});

type Published = { authorization: string | null; body: Record<string, unknown> };

// A stand-in ntfy server that records each publish and answers `status`.
const stubNtfy = (status = 200) => {
  const received: Published[] = [];
  const server = Bun.serve({
    fetch: async (request) => {
      received.push({
        authorization: request.headers.get('authorization'),
        body: (await request.json()) as Record<string, unknown>,
      });
      return Response.json({ id: 'x' }, { status });
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  return { received, server, [Symbol.dispose]: () => void server.stop(true) };
};

// A database no test reaches, for the commands that name one but fail first.
const UNREACHED_DATABASE = new URL('postgres://heimdall@127.0.0.1:1/heimdall');

// A configuration with a `[delivery]` section and the database `delivery test`
// clears the failing status in.
const deliveryConfig = (url: URL, database = UNREACHED_DATABASE) =>
  configFile([
    '[database]',
    `url = "${database.href}"`,
    '[delivery]',
    `url = "${url.href}"`,
    'topic = "heimdall-x7Qp"',
    'token = "tk_s3cret"',
    'dashboard = "https://dashboard.example/"',
  ]);

const FAILING_SINCE = '2026-10-06T12:00:00Z';

const failingRun = async (db: { sql: SQL }) => {
  const rows: { failing_since: Date | null }[] =
    await db.sql`SELECT failing_since FROM delivery_status`;
  return rows.map((row) => row.failing_since?.toISOString() ?? null);
};

test('delivery test sends one low-priority message that opens the dashboard, and prints neither topic nor token', async () => {
  using ntfy = stubNtfy();
  await using db = await migratedDatabase();
  await using config = await deliveryConfig(ntfy.server.url, db.url);

  const { code, stderr, stdout } = await invoke(['delivery', 'test', ...configArgs(config)]);

  expect(ntfy.received).toEqual([
    {
      authorization: 'Bearer tk_s3cret',
      body: {
        click: 'https://dashboard.example/',
        message: 'Alert delivery works. This message is only a test.',
        priority: 2,
        tags: ['white_check_mark'],
        title: 'Heimdall test',
        topic: 'heimdall-x7Qp',
      },
    },
  ]);
  expect(stdout).toContain(`Sent a test message through ${ntfy.server.url.host}.\n`);
  expect(`${stdout}${stderr}`).not.toContain('heimdall-x7Qp');
  expect(`${stdout}${stderr}`).not.toContain('tk_s3cret');
  expect(stderr).toBe('');
  expect(code).toBe(0);
});

test('a delivery test that gets through ends a stored run of failed sends', async () => {
  using ntfy = stubNtfy();
  await using db = await migratedDatabase();
  await db.sql`UPDATE delivery_status SET failing_since = ${FAILING_SINCE}`;
  await using config = await deliveryConfig(ntfy.server.url, db.url);

  const { code, stdout } = await invoke(['delivery', 'test', ...configArgs(config)]);

  expect(await failingRun(db)).toEqual([null]);
  expect(stdout).toContain('Sent a test message');
  expect(code).toBe(0);
});

test('a delivery test that gets through says so even when the database cannot be reached', async () => {
  using ntfy = stubNtfy();
  await using config = await deliveryConfig(ntfy.server.url);

  const { code, stderr, stdout } = await invoke(['delivery', 'test', ...configArgs(config)]);

  expect(ntfy.received).toHaveLength(1);
  expect(stdout).toContain(`Sent a test message through ${ntfy.server.url.host}.\n`);
  expect(stderr).toContain('Could not reach the database:');
  expect(code).toBe(1);
});

test('delivery test fails with the status when ntfy refuses the message, and leaves a stored run alone', async () => {
  using ntfy = stubNtfy(403);
  await using db = await migratedDatabase();
  await db.sql`UPDATE delivery_status SET failing_since = ${FAILING_SINCE}`;
  await using config = await deliveryConfig(ntfy.server.url, db.url);

  const { code, stderr, stdout } = await invoke(['delivery', 'test', ...configArgs(config)]);

  expect(stderr).toContain('Could not send the test message: The ntfy server answered 403.');
  expect(`${stdout}${stderr}`).not.toContain('heimdall-x7Qp');
  expect(`${stdout}${stderr}`).not.toContain('tk_s3cret');
  expect(await failingRun(db)).toEqual([new Date(FAILING_SINCE).toISOString()]);
  expect(code).toBe(1);
});

test('delivery test fails when the ntfy server cannot be reached', async () => {
  const ntfy = stubNtfy();
  const { url } = ntfy.server;
  ntfy[Symbol.dispose]();
  await using config = await deliveryConfig(url);

  const { code, stderr, stdout } = await invoke(['delivery', 'test', ...configArgs(config)]);

  expect(stderr).toContain('Could not send the test message:');
  expect(`${stdout}${stderr}`).not.toContain('heimdall-x7Qp');
  expect(`${stdout}${stderr}`).not.toContain('tk_s3cret');
  expect(code).toBe(1);
});

test('delivery test without a [delivery] section says delivery is off', async () => {
  await using config = await configFile(['[database]', `url = "${UNREACHED_DATABASE.href}"`]);

  const { code, stderr, stdout } = await invoke(['delivery', 'test', ...configArgs(config)]);

  expect(stderr).toContain('no [delivery] section');
  expect(stdout).toBe('');
  expect(code).toBe(1);
});

test('delivery test refuses an invalid [delivery] section, naming the setting', async () => {
  await using config = await configFile([
    '[database]',
    `url = "${UNREACHED_DATABASE.href}"`,
    '[delivery]',
    'url = "https://ntfy.example"',
    'topic = "not a topic"',
    'dashboard = "https://dashboard.example/"',
  ]);

  const { code, stderr } = await invoke(['delivery', 'test', ...configArgs(config)]);

  expect(stderr).toContain('Invalid Hub delivery settings: delivery.topic');
  expect(stderr).not.toContain('not a topic');
  expect(code).toBe(1);
});

test('serve without a [delivery] section clears a delivery status left from before', async () => {
  await using db = await migratedDatabase();
  await db.sql`UPDATE delivery_status SET failing_since = now()`;
  await using config = await hubConfig(db);

  const { code } = await invoke(['serve', ...configArgs(config)]);

  const rows: { failing_since: Date | null }[] =
    await db.sql`SELECT failing_since FROM delivery_status`;
  expect(rows).toEqual([{ failing_since: null }]);
  expect(code).toBe(130);
});

test('serve with a [delivery] section leaves the delivery status alone', async () => {
  await using db = await migratedDatabase();
  await db.sql`UPDATE delivery_status SET failing_since = '2026-10-06T12:00:00Z'`;
  using ntfy = stubNtfy();
  await using config = await hubConfig(db, [
    '[delivery]',
    `url = "${ntfy.server.url.href}"`,
    'topic = "heimdall-x7Qp"',
    'dashboard = "https://dashboard.example/"',
  ]);

  await invoke(['serve', ...configArgs(config)]);

  const rows: { failing_since: Date | null }[] =
    await db.sql`SELECT failing_since FROM delivery_status`;
  expect(rows).toEqual([{ failing_since: new Date('2026-10-06T12:00:00Z') }]);
});
