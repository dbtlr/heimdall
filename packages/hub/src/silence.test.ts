import { expect, test } from 'bun:test';

import { SQL } from 'bun';

import { DELIVERY_LOCK } from './delivery.ts';
import { unpair } from './pairing.ts';
import { setSilence } from './silences.ts';
import { configArgs, hubConfig, invoke } from './testing/cli.ts';
import { migratedDatabase } from './testing/postgres.ts';
import { storeToken } from './tokens.ts';

const ISO = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;

// A migrated database with laptop-1 and server-1 paired, and the Hub's
// configuration file for it.
const setup = async () => {
  const db = await migratedDatabase();
  await storeToken(db.sql, { pairedAt: Date.now(), system: 'laptop-1', token: 'laptop-token' });
  await storeToken(db.sql, { pairedAt: Date.now(), system: 'server-1', token: 'server-token' });
  const config = await hubConfig(db);
  const silences = () =>
    db.sql`SELECT system, until FROM silences ORDER BY system` as Promise<
      { system: string; until: Date }[]
    >;
  return {
    args: configArgs(config),
    db,
    silences,
    [Symbol.asyncDispose]: async () => {
      await config[Symbol.asyncDispose]();
      await db[Symbol.asyncDispose]();
    },
  };
};

test('silence --for holds a System until now plus the duration, and says its Conditions stay', async () => {
  await using s = await setup();
  const before = Date.now();

  const { code, stdout } = await invoke(['silence', 'laptop-1', '--for', '2h', ...s.args]);

  const [row] = await s.silences();
  expect(row?.system).toBe('laptop-1');
  const until = row?.until.getTime() ?? 0;
  expect(until).toBeGreaterThanOrEqual(before + 2 * 3_600_000);
  expect(until).toBeLessThan(before + 2 * 3_600_000 + 60_000);
  expect(stdout).toBe(
    `Silenced laptop-1 until ${new Date(until).toISOString()}. Its Conditions stay on the dashboard; delivery holds until then.\n`,
  );
  expect(code).toBe(0);
});

test('silence --for on a System already silenced replaces its end', async () => {
  await using s = await setup();
  await invoke(['silence', 'laptop-1', '--for', '1d', ...s.args]);
  const before = Date.now();

  const { code } = await invoke(['silence', 'laptop-1', '--for', '30m', ...s.args]);

  const rows = await s.silences();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.until.getTime()).toBeLessThan(before + 31 * 60_000);
  expect(code).toBe(0);
});

test('silence --clear ends a silence, says delivery resumes, and leaves other Systems silenced', async () => {
  await using s = await setup();
  await invoke(['silence', 'laptop-1', '--for', '2h', ...s.args]);
  await invoke(['silence', 'server-1', '--for', '2h', ...s.args]);

  const { code, stdout } = await invoke(['silence', 'laptop-1', '--clear', ...s.args]);

  expect(stdout).toBe('Ended the silence on laptop-1. Delivery resumes.\n');
  expect(code).toBe(0);
  expect((await s.silences()).map((row) => row.system)).toEqual(['server-1']);
});

test('silence --clear on a System with no active silence says so and exits 1', async () => {
  await using s = await setup();

  const { code, stderr } = await invoke(['silence', 'laptop-1', '--clear', ...s.args]);

  expect(stderr).toContain('laptop-1 has no active silence.');
  expect(code).toBe(1);
});

test('silence with no System lists the active silences with their end and time left', async () => {
  await using s = await setup();
  await invoke(['silence', 'server-1', '--for', '1d', ...s.args]);
  await invoke(['silence', 'laptop-1', '--for', '1h30m', ...s.args]);

  const { code, stdout } = await invoke(['silence', ...s.args]);

  const lines = stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(new RegExp(`^laptop-1 until ${ISO} \\(1 h 30 min left\\)$`, 'u'));
  expect(lines[1]).toMatch(new RegExp(`^server-1 until ${ISO} \\(24 h left\\)$`, 'u'));
  expect(code).toBe(0);
});

test('silence with no System says none are active, and ignores one that has ended', async () => {
  await using s = await setup();
  await s.db.sql`
    INSERT INTO silences (system, until, created_at)
    VALUES ('laptop-1', now() - interval '1 minute', now() - interval '1 hour')
  `;

  const { code, stdout } = await invoke(['silence', ...s.args]);

  expect(stdout).toBe('No active silences.\n');
  expect(code).toBe(0);
});

test('silence --clear on a silence that has ended says there is none', async () => {
  await using s = await setup();
  await s.db.sql`
    INSERT INTO silences (system, until, created_at)
    VALUES ('laptop-1', now() - interval '1 minute', now() - interval '1 hour')
  `;

  const { code, stderr } = await invoke(['silence', 'laptop-1', '--clear', ...s.args]);

  expect(stderr).toContain('laptop-1 has no active silence.');
  expect(code).toBe(1);
});

test('unpairing a silenced System ends its silence, so pairing it again is not silenced', async () => {
  await using s = await setup();
  await invoke(['silence', 'laptop-1', '--for', '2h', ...s.args]);

  await unpair(s.db.sql, 'laptop-1');
  await storeToken(s.db.sql, { pairedAt: Date.now(), system: 'laptop-1', token: 'again' });

  expect(await s.silences()).toEqual([]);
});

test('silence of a System that is not paired is refused, and stores nothing', async () => {
  await using s = await setup();

  const { code, stderr } = await invoke(['silence', 'desktop-1', '--for', '2h', ...s.args]);

  expect(stderr).toContain('desktop-1 is not paired.');
  expect(code).toBe(1);
  expect(await s.silences()).toEqual([]);
});

test.each([['soon']])('silence --for %p is a usage error', async (value) => {
  const { code, stderr } = await invoke([
    'silence',
    'laptop-1',
    '--for',
    value,
    '--database',
    'postgres://db/heimdall',
  ]);

  expect(stderr).toContain('Use a duration of up to 365 days, such as 30m, 2h, 1d, or 1h30m.');
  expect(code).toBe(2);
});

test.each([
  [['laptop-1', '--for', '2h', '--clear'], 'not both'],
  [['laptop-1'], 'Give --for <duration>'],
  [['--for', '2h'], 'Name the System'],
])('silence %p is refused before it opens the database', async (argv, message) => {
  const { code, stderr } = await invoke([
    'silence',
    ...argv,
    '--database',
    'postgres://db/heimdall',
  ]);

  expect(stderr).toContain(message);
  expect(code).not.toBe(0);
  expect(stderr).not.toContain('database');
});

test('silence, like pair, takes a Fleet System name', async () => {
  const { code, stderr } = await invoke([
    'silence',
    'LAPTOP_1',
    '--for',
    '2h',
    '--database',
    'postgres://db/heimdall',
  ]);

  expect(stderr).toContain('Fleet System name');
  expect(code).toBe(2);
});

// Waits until a session on this database waits for a lock.
const waitForLockWait = async (sql: SQL) => {
  const deadline = Date.now() + 5000;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- polls until the session blocks.
    const [row]: { n: number }[] = await sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if ((row?.n ?? 0) > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error('No session waits for a lock.');
    }
    // oxlint-disable-next-line no-await-in-loop -- polls until the session blocks.
    await Bun.sleep(10);
  }
};

test('a silence waits out a delivery pass in progress, so that pass cannot send what it silences', async () => {
  await using s = await setup();
  const pass = await s.db.sql.reserve();
  await pass`SELECT pg_advisory_lock(hashtext(${DELIVERY_LOCK}))`;

  const silenced = setSilence(s.db.sql, { forMs: 3_600_000, now: Date.now(), system: 'laptop-1' });
  await waitForLockWait(s.db.sql);
  const duringPass = await s.silences();
  await pass`SELECT pg_advisory_unlock(hashtext(${DELIVERY_LOCK}))`;
  pass.release();
  await silenced;

  expect(duringPass).toEqual([]);
  expect(await s.silences()).toHaveLength(1);
});

test('a silence outlasts the statement timeout while it waits for a slow delivery pass', async () => {
  await using s = await setup();
  const impatient = new SQL({ connection: { statement_timeout: 100 }, url: s.db.url.href });
  const pass = await s.db.sql.reserve();
  await pass`SELECT pg_advisory_lock(hashtext(${DELIVERY_LOCK}))`;

  const silenced = setSilence(impatient, { forMs: 3_600_000, now: Date.now(), system: 'laptop-1' });
  await Bun.sleep(300);
  await pass`SELECT pg_advisory_unlock(hashtext(${DELIVERY_LOCK}))`;
  pass.release();

  expect(await silenced).toBeInstanceOf(Date);
  await impatient.close();
});
