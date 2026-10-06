import { expect, test } from 'bun:test';

import { migrate, MIGRATIONS } from './migrations.ts';
import { testDatabase } from './testing/postgres.ts';

test('migrate brings an empty database to the latest version', async () => {
  await using db = await testDatabase();

  const applied = await migrate(db.sql);

  expect(applied).toEqual(MIGRATIONS.map((m) => m.version));
});

test('migrate applies nothing to a database already at the latest version', async () => {
  await using db = await testDatabase();
  await migrate(db.sql);

  expect(await migrate(db.sql)).toEqual([]);
});

test('concurrent migrations apply each version once', async () => {
  await using db = await testDatabase();

  const [first, second] = await Promise.all([migrate(db.sql), migrate(db.sql)]);

  expect([...(first ?? []), ...(second ?? [])].toSorted((a, b) => a - b)).toEqual(
    MIGRATIONS.map((m) => m.version),
  );
});
