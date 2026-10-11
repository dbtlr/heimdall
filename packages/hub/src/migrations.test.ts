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

test('migrate fails with lock_not_available, not a statement timeout, when a lock stays held', async () => {
  await using db = await testDatabase();
  await migrate(db.sql);
  const session = await db.sql.reserve();
  await session.unsafe('BEGIN');
  await session.unsafe('LOCK TABLE systems IN ACCESS SHARE MODE');

  const pending = [
    ...MIGRATIONS,
    { sql: 'ALTER TABLE systems ADD COLUMN note text', version: 9999 },
  ];
  const started = Date.now();
  const failure = await migrate(db.sql, pending, { lockTimeoutMs: 100 }).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({ errno: '55P03' });
  expect(Date.now() - started).toBeLessThan(5000);
  await session.unsafe('ROLLBACK');
  session.release();
  expect(await migrate(db.sql, pending)).toEqual([9999]);
});
