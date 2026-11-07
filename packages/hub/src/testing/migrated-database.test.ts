import { expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { migrate } from '../migrations.ts';
import { storeToken } from '../tokens.ts';
import { migratedDatabase, releaseSharedDatabase, testDatabase } from './postgres.ts';

// Each table's row count, for every table that has rows.
const rowCounts = async (sql: SQL) => {
  const tables: { name: string }[] =
    await sql`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`;
  const counts = await Promise.all(
    tables.map(async ({ name }) => {
      const [row]: { n: number }[] = await sql.unsafe(`SELECT count(*)::int AS n FROM "${name}"`);
      return [name, row?.n ?? 0] as const;
    }),
  );
  return Object.fromEntries(counts.filter(([, n]) => n > 0));
};

const pairedCount = async (sql: SQL) => {
  const [row]: { n: number }[] = await sql`SELECT count(*)::int AS n FROM paired_systems`;
  return row?.n;
};

const freshCounts = async () => {
  await using fresh = await testDatabase();
  await migrate(fresh.sql);
  return await rowCounts(fresh.sql);
};

test('a migrated database holds only what migrating seeds, whatever the test before it stored', async () => {
  {
    await using before = await migratedDatabase();
    await storeToken(before.sql, { pairedAt: 0, system: 'server-1', token: 'server-token' });
    await before.sql`UPDATE hub_listening SET heard_at = heard_at + interval '1 day'`;
  }
  const seeded = await freshCounts();
  await using db = await migratedDatabase();
  expect(await rowCounts(db.sql)).toEqual(seeded);
  expect(await pairedCount(db.sql)).toBe(0);
});

test('a migrated database has none of the schema changes the test before it made', async () => {
  {
    await using before = await migratedDatabase();
    await before.sql.unsafe(`
      CREATE FUNCTION refuse() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'refused'; END $$;
      CREATE TRIGGER refuse BEFORE INSERT ON paired_systems FOR EACH ROW EXECUTE FUNCTION refuse();
    `);
  }
  await using db = await migratedDatabase();
  await storeToken(db.sql, { pairedAt: 0, system: 'server-1', token: 'server-token' });
  expect(await pairedCount(db.sql)).toBe(1);
});

test('a migrated database has every trigger migrating made firing, whatever the test before it disabled', async () => {
  {
    await using before = await migratedDatabase();
    await before.sql`ALTER TABLE model_prices DISABLE TRIGGER mark_stale_on_price_change`;
  }
  await using db = await migratedDatabase();
  const [trigger]: { enabled: string }[] = await db.sql`
    SELECT tgenabled AS enabled FROM pg_trigger WHERE tgname = 'mark_stale_on_price_change'`;
  expect(trigger?.enabled).toBe('O');
});

test('two migrated databases in use at once are separate', async () => {
  await using first = await migratedDatabase();
  await using second = await migratedDatabase();
  await storeToken(first.sql, { pairedAt: 0, system: 'server-1', token: 'server-token' });
  expect(await pairedCount(second.sql)).toBe(0);
  expect(await pairedCount(first.sql)).toBe(1);
});

// As a test that timed out before its dispose ran leaves it (HMD-199).
test('a migrated database a finished test still held goes to the next test, its pool closed', async () => {
  const abandoned = await migratedDatabase();
  // What the abandoned pool's query fails with.
  const running = (async () => {
    try {
      await abandoned.sql`SELECT pg_sleep(60)`;
      return undefined;
    } catch (error) {
      return error;
    }
  })();

  await releaseSharedDatabase();

  await using db = await migratedDatabase();
  expect(db.url.href).toBe(abandoned.url.href);
  expect(await running).toMatchObject({ code: 'ERR_POSTGRES_CONNECTION_CLOSED' });
});

// A test that timed out while its setup still ran, whose setup then finishes
// after the next test took the database.
test('a migrated database call released during its setup cannot take the database from the next test', async () => {
  const outcome = (async () => {
    try {
      return { database: await migratedDatabase() };
    } catch (error) {
      return { error };
    }
  })();

  await releaseSharedDatabase();

  await using next = await migratedDatabase();
  await storeToken(next.sql, { pairedAt: 0, system: 'server-1', token: 'server-token' });
  const settled = await outcome;
  if ('database' in settled) {
    await settled.database[Symbol.asyncDispose]();
  }

  expect('error' in settled).toBe(true);
  expect(await pairedCount(next.sql)).toBe(1);
});
