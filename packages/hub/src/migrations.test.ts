import { expect, test } from 'bun:test';

import { SQL } from 'bun';

import { STATEMENT_TIMEOUT_MS } from './database.ts';
import { migrate, MIGRATION_LOCK_TIMEOUT_MS, MIGRATIONS } from './migrations.ts';
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

test('a lock wait ends before the statement timeout can', () => {
  expect(MIGRATION_LOCK_TIMEOUT_MS).toBeLessThan(STATEMENT_TIMEOUT_MS);
});

test('migrate leaves no lock timeout on the connection it used', async () => {
  await using db = await testDatabase();
  const single = new SQL({ max: 1, url: db.url.href });

  await migrate(single);
  const [row]: { lock_timeout: string }[] = await single`SHOW lock_timeout`;
  await single.close();

  expect(row?.lock_timeout).toBe('0');
});

// Generations uploaded before the Hub kept each source's Harness still get
// parsed (ADR-0014): the sets the Hub holds name most sources, and a source no
// set names runs the Harness it is named after, the default name.
test('migration 13 maps each held source to its Harness, and a source named for a Harness to it', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 12),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;
  await db.sql`
    INSERT INTO transcript_sources (system, sources, spool_bytes, sent_at)
    VALUES ('laptop-1', '[{"harness":"claude-code","name":"work","status":"capturing"}]', 0, now())
  `;
  await db.sql`
    INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
    VALUES (1, 'laptop-1', 'work', 'projects/p/a.jsonl', now(), now()),
           (2, 'laptop-1', 'codex', 'sessions/2026/10/01/r.jsonl', now(), now()),
           (3, 'laptop-1', 'removed', 'projects/p/b.jsonl', now(), now())
  `;

  expect(
    await migrate(
      db.sql,
      MIGRATIONS.filter((m) => m.version <= 13),
    ),
  ).toEqual([13]);

  const rows =
    await db.sql`SELECT source, harness FROM transcript_source_harnesses ORDER BY source`;
  expect(rows).toEqual([
    { harness: 'codex', source: 'codex' },
    { harness: 'claude-code', source: 'work' },
  ]);
});
