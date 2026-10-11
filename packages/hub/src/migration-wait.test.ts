import { expect, test } from 'bun:test';

import {
  backoffMs,
  describeLockWait,
  lockHolders,
  migrateWhenFree,
  oncePerInterval,
} from './migration-wait.ts';
import type { LockHolder } from './migration-wait.ts';
import { migrate, MIGRATIONS } from './migrations.ts';
import { testDatabase } from './testing/postgres.ts';

const ALTER_SYSTEMS = { sql: 'ALTER TABLE systems ADD COLUMN note text', version: 9999 };
const SHORT_LOCK_TIMEOUT_MS = 100;

// A second session that holds a lock on `systems` in an open transaction, as a
// stalled backup does. `release` commits it.
const holdSystems = async (db: Awaited<ReturnType<typeof testDatabase>>) => {
  const session = await db.sql.reserve();
  await session.unsafe(`SET application_name = 'stalled-backup'`);
  await session.unsafe('BEGIN');
  await session.unsafe('LOCK TABLE systems IN ACCESS SHARE MODE');
  const [row]: { pid: number }[] = await session`SELECT pg_backend_pid() AS pid`;
  return {
    pid: row?.pid ?? 0,
    release: async () => {
      await session.unsafe('COMMIT');
      session.release();
    },
  };
};

// What `work` rejected with, or undefined if it resolved.
const failureOf = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error;
  }
  return undefined;
};

const ready = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  return db;
};

test('backoff doubles from one second and stops at thirty', () => {
  expect([0, 1, 2, 3, 4, 5, 6, 20].map(backoffMs)).toEqual([
    1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
  ]);
});

test('oncePerInterval allows the first call, then none until the interval passes', () => {
  let clock = 1_000_000;
  const allow = oncePerInterval(60_000, () => clock);

  const results = [allow()];
  clock += 59_999;
  results.push(allow());
  clock += 1;
  results.push(allow());
  clock += 30_000;
  results.push(allow());

  expect(results).toEqual([true, false, true, false]);
});

test('describeLockWait names each holder, and says so when none can be found', () => {
  const holder: LockHolder = {
    applicationName: 'pg_dump',
    locked: 'systems',
    pid: 4242,
    since: new Date('2026-10-10T01:02:03.000Z'),
    state: 'idle in transaction',
  };

  expect(describeLockWait([holder])).toBe(
    'Waiting for a database lock. Held by pid 4242 (application_name "pg_dump", idle in transaction since 2026-10-10T01:02:03.000Z) on systems. Retrying.',
  );
  expect(describeLockWait([])).toBe(
    'Waiting for a database lock. Could not tell which session holds it. Retrying.',
  );
});

test('lockHolders finds the session holding a lock on a table, never its own', async () => {
  await using db = await ready();
  const holder = await holdSystems(db);

  const holders = await lockHolders(db.sql);
  await holder.release();

  expect(holders.map((h) => h.pid)).toEqual([holder.pid]);
  expect(holders[0]).toMatchObject({
    applicationName: 'stalled-backup',
    locked: 'systems',
    state: 'idle in transaction',
  });
  expect(holders[0]?.since).toBeInstanceOf(Date);
});

test('a migration that waits on a held lock logs the holder, then applies once it is released', async () => {
  await using db = await ready();
  const holder = await holdSystems(db);
  const blocked: LockHolder[][] = [];
  let sleeps = 0;

  const applied = await migrateWhenFree(db.sql, {
    lockTimeoutMs: SHORT_LOCK_TIMEOUT_MS,
    migrations: [...MIGRATIONS, ALTER_SYSTEMS],
    onBlocked: (holders) => {
      blocked.push(holders);
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) {
        await holder.release();
      }
    },
  });

  expect(applied).toEqual([9999]);
  expect(sleeps).toBe(2);
  expect(blocked).toHaveLength(1);
  expect(blocked[0]?.[0]).toMatchObject({ applicationName: 'stalled-backup', pid: holder.pid });
  const columns: { column_name: string }[] =
    await db.sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'systems'`;
  expect(columns.map((c) => c.column_name)).toContain('note');
});

test('the holder is logged at most once a minute while the wait goes on', async () => {
  await using db = await ready();
  const holder = await holdSystems(db);
  let clock = 0;
  let logged = 0;
  let sleeps = 0;

  await migrateWhenFree(db.sql, {
    lockTimeoutMs: SHORT_LOCK_TIMEOUT_MS,
    migrations: [...MIGRATIONS, ALTER_SYSTEMS],
    now: () => clock,
    onBlocked: () => {
      logged += 1;
    },
    sleep: async () => {
      sleeps += 1;
      clock += 20_000;
      if (sleeps === 7) {
        await holder.release();
      }
    },
  });

  // Attempts fail at 0 s, 20, 40, 60, 80, 100, and 120 s; the log is due at 0, 60, and 120.
  expect(logged).toBe(3);
});

test('a wait ends with the lock error when the caller stops it', async () => {
  await using db = await ready();
  const holder = await holdSystems(db);
  const controller = new AbortController();

  const waiting = migrateWhenFree(db.sql, {
    lockTimeoutMs: SHORT_LOCK_TIMEOUT_MS,
    migrations: [...MIGRATIONS, ALTER_SYSTEMS],
    onBlocked: () => {},
    signal: controller.signal,
    sleep: () => {
      controller.abort();
      return Promise.resolve();
    },
  });

  expect(await failureOf(waiting)).toMatchObject({ errno: '55P03' });
  await holder.release();
});

test('a migration error that is not a lock wait still rejects, without waiting', async () => {
  await using db = await ready();
  let slept = false;
  let logged = false;

  const failed = migrateWhenFree(db.sql, {
    migrations: [...MIGRATIONS, { sql: 'ALTER TABLE nowhere ADD COLUMN x int', version: 9999 }],
    onBlocked: () => {
      logged = true;
    },
    sleep: () => {
      slept = true;
      return Promise.resolve();
    },
  });

  expect(await failureOf(failed)).toHaveProperty('message', expect.stringContaining('nowhere'));
  expect(slept).toBe(false);
  expect(logged).toBe(false);
});

test('a wait sleeps one second, then doubles, to a cap of thirty', async () => {
  await using db = await ready();
  const holder = await holdSystems(db);
  const slept: number[] = [];

  await migrateWhenFree(db.sql, {
    lockTimeoutMs: SHORT_LOCK_TIMEOUT_MS,
    migrations: [...MIGRATIONS, ALTER_SYSTEMS],
    onBlocked: () => {},
    sleep: async (ms) => {
      slept.push(ms);
      if (slept.length === 7) {
        await holder.release();
      }
    },
  });

  expect(slept).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
});

test('an abort during the backoff runs no further attempt', async () => {
  await using db = await ready();
  const holder = await holdSystems(db);
  const controller = new AbortController();

  const failure = await failureOf(
    migrateWhenFree(db.sql, {
      lockTimeoutMs: SHORT_LOCK_TIMEOUT_MS,
      migrations: [...MIGRATIONS, ALTER_SYSTEMS],
      onBlocked: () => {},
      signal: controller.signal,
      sleep: async () => {
        // With the lock free, any further attempt would apply the migration.
        controller.abort();
        await holder.release();
      },
    }),
  );

  expect(failure).toMatchObject({ errno: '55P03' });
  const columns: { column_name: string }[] =
    await db.sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'systems'`;
  expect(columns.map((c) => c.column_name)).not.toContain('note');
});

test('the holder is logged again at exactly sixty seconds, not at fifty-nine', async () => {
  await using db = await ready();
  const holder = await holdSystems(db);
  let clock = 5_000;
  const loggedAt: number[] = [];
  const steps = [59_999, 1, 1];
  let sleeps = 0;

  await migrateWhenFree(db.sql, {
    lockTimeoutMs: SHORT_LOCK_TIMEOUT_MS,
    migrations: [...MIGRATIONS, ALTER_SYSTEMS],
    now: () => clock,
    onBlocked: () => {
      loggedAt.push(clock);
    },
    sleep: async () => {
      clock += steps[sleeps] ?? 0;
      sleeps += 1;
      if (sleeps === steps.length) {
        await holder.release();
      }
    },
  });

  expect(loggedAt).toEqual([5000, 65_000]);
});

test('a holder lookup that fails does not end the wait', async () => {
  await using db = await ready();
  const holder = await holdSystems(db);
  const blocked: LockHolder[][] = [];
  let sleeps = 0;

  const applied = await migrateWhenFree(db.sql, {
    lockTimeoutMs: SHORT_LOCK_TIMEOUT_MS,
    lookupHolders: () => Promise.reject(new Error('permission denied for pg_locks')),
    migrations: [...MIGRATIONS, ALTER_SYSTEMS],
    onBlocked: (holders) => {
      blocked.push(holders);
    },
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 2) {
        await holder.release();
      }
    },
  });

  expect(applied).toEqual([9999]);
  expect(blocked).toEqual([[]]);
});
