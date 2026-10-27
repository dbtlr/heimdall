import { expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { migrate } from '../migrations.ts';
import { storeToken } from '../tokens.ts';
import { migratedDatabase, testDatabase } from './postgres.ts';

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
