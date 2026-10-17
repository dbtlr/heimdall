import { beforeAll, expect, test } from 'bun:test';

import { SQL } from 'bun';

import { STATEMENT_TIMEOUT_MS } from './database.ts';
import { migrate, MIGRATION_LOCK_TIMEOUT_MS, MIGRATIONS } from './migrations.ts';
import { startTestServer, testDatabase } from './testing/postgres.ts';
import { timeline } from './testing/timeline.ts';

const DAY = 86_400;
const apt = (name: string) => JSON.stringify(['apt', '/usr/bin/apt', name]);
const brew = (name: string) => JSON.stringify(['homebrew', '/opt/hom"ebrew', name]);

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

test('load cache migration preserves replay progress and invalidates existing judgments', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 26),
  );
  await db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await db.sql`
    INSERT INTO load_evaluations (system, through, dirty_from, pending_from, cpu_known, memory_known)
    VALUES ('laptop-1', '2026-10-01T12:00:00Z', '2026-10-01T11:00:00Z', '2026-10-01T10:00:00Z', true, false)
  `;
  const before: Record<string, unknown>[] = await db.sql`SELECT * FROM load_evaluations`;
  await migrate(db.sql);
  const after: Record<string, unknown>[] = await db.sql`SELECT * FROM load_evaluations`;
  expect(after).toEqual(before.map((row) => Object.assign(row, { fingerprint: null })));
});

test('hot-process cache migration preserves replay progress and invalidates existing judgments', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 27),
  );
  await db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await db.sql`
    INSERT INTO hot_process_evaluations (system, through, dirty_from, pending_from, coverage, limits)
    VALUES ('laptop-1', '2026-10-01T12:00:00Z', '2026-10-01T11:00:00Z', '2026-10-01T10:00:00Z', '{"a":true}', '{"cores":0.5}')
  `;
  const before: Record<string, unknown>[] = await db.sql`SELECT * FROM hot_process_evaluations`;
  await migrate(db.sql);
  const after: Record<string, unknown>[] = await db.sql`SELECT * FROM hot_process_evaluations`;
  for (const row of before) {
    Reflect.deleteProperty(row, 'limits');
  }
  expect(after).toEqual(before.map((row) => Object.assign(row, { fingerprint: null })));
});

test('Condition levels preserve legacy occurrences and identify backfilled history', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 22),
  );
  await db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await db.sql`
    INSERT INTO conditions (system, kind, subject, raised_at, raised_reason, latest_at, latest_reason, cleared_at)
    VALUES ('laptop-1', 'low_disk', '/', '2026-10-01Z', 'disk raised', '2026-10-02Z', 'disk latest', NULL),
           ('laptop-1', 'drift', '/a', '2026-09-01Z', 'file raised', '2026-09-02Z', 'file latest', '2026-09-03Z')
  `;
  const before: Record<string, unknown>[] = await db.sql`SELECT * FROM conditions ORDER BY id`;

  await migrate(db.sql);

  const after: Record<string, unknown>[] = await db.sql`SELECT * FROM conditions ORDER BY id`;
  expect(after.map(({ level: _level, ...row }) => row)).toEqual(before);
  expect(after.map((row) => row.level)).toEqual(['alert', 'warning']);
  const events: {
    kind: string;
    action: string;
    level: string;
    previous_level: string | null;
    backfilled: boolean;
    reason: string;
    at: Date;
  }[] = await db.sql`
    SELECT c.kind, e.action, e.level, e.previous_level, e.backfilled, e.reason, e.at
    FROM condition_transitions e JOIN conditions c ON c.id = e.condition
    ORDER BY c.id, e.id
  `;
  expect(events).toEqual([
    {
      action: 'raised',
      at: new Date('2026-10-01Z'),
      backfilled: true,
      kind: 'low_disk',
      level: 'alert',
      previous_level: null,
      reason: 'disk raised',
    },
    {
      action: 'raised',
      at: new Date('2026-09-01Z'),
      backfilled: true,
      kind: 'drift',
      level: 'warning',
      previous_level: null,
      reason: 'file raised',
    },
    {
      action: 'cleared',
      at: new Date('2026-09-03Z'),
      backfilled: true,
      kind: 'drift',
      level: 'warning',
      previous_level: null,
      reason: 'file latest',
    },
  ]);
});

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
test('migration 15 maps each held source to its Harness, and a source named for a Harness to it', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 14),
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
      MIGRATIONS.filter((m) => m.version <= 15),
    ),
  ).toEqual([15]);

  const rows =
    await db.sql`SELECT source, harness FROM transcript_source_harnesses ORDER BY source`;
  expect(rows).toEqual([
    { harness: 'codex', source: 'codex' },
    { harness: 'claude-code', source: 'work' },
  ]);
});

test('migration 7 applies on top of version 6 and keeps what was there', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 6),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;

  expect(
    await migrate(
      db.sql,
      MIGRATIONS.filter((m) => m.version <= 7),
    ),
  ).toEqual([7]);

  const rows = await db.sql`SELECT name FROM systems`;
  expect(rows).toHaveLength(1);
});

test('migration 8 applies on top of version 7 and leaves a System with no time zone or runs', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 7),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;

  expect(
    await migrate(
      db.sql,
      MIGRATIONS.filter((m) => m.version <= 8),
    ),
  ).toEqual([8]);

  const rows = await db.sql`
    SELECT s.name, s.time_zone, r.system AS runs_system
    FROM systems s LEFT JOIN run_sets r ON r.system = s.name
  `;
  expect(rows).toEqual([{ name: 'laptop-1', runs_system: null, time_zone: null }]);
});

test('migration 11 applies on top of the earlier versions and leaves a System with no checks', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version < 11),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;

  expect(
    await migrate(
      db.sql,
      MIGRATIONS.filter((m) => m.version <= 11),
    ),
  ).toEqual([11]);

  const rows = await db.sql`
    SELECT s.name, c.system AS checks_system
    FROM systems s LEFT JOIN check_sets c ON c.system = s.name
  `;
  expect(rows).toEqual([{ checks_system: null, name: 'laptop-1' }]);
});

test('migration 12 keeps the size of checks that were over budget as that of the files part, has no services, and lets the files be null', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 11),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;
  await db.sql`
    INSERT INTO check_sets (system, sent_at, received_at, over_budget_bytes, files)
    VALUES ('laptop-1', now(), now(), 2000000, '[{"path":"/a"}]')
  `;

  expect(
    await migrate(
      db.sql,
      MIGRATIONS.filter((m) => m.version <= 12),
    ),
  ).toEqual([12]);
  await db.sql`UPDATE check_sets SET file_records = NULL`;

  const rows = await db.sql`
    SELECT files, file_records, files_over_budget_bytes, services, services_over_budget_bytes
    FROM check_sets
  `;
  expect(rows).toEqual([
    {
      file_records: null,
      files: [{ path: '/a' }],
      files_over_budget_bytes: '2000000',
      services: null,
      services_over_budget_bytes: null,
    },
  ]);
});

test('per-package update Conditions merge into one open Condition for each package source', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 29),
  );
  await db.sql`INSERT INTO systems (name) VALUES ('laptop-1'), ('server-1')`;
  const { addCondition, at } = timeline(Date.UTC(2026, 9, 6, 12, 0, 0));
  const common = { kind: 'pending_update', system: 'laptop-1' } as const;
  // The earliest apt occurrence is a note; a later one went warning, then back.
  const first = await addCondition(db.sql, {
    ...common,
    level: 'note',
    raisedAt: -3 * DAY,
    subject: apt('curl'),
  });
  const second = await addCondition(db.sql, {
    ...common,
    level: 'note',
    raisedAt: -2 * DAY,
    subject: apt('openssl'),
    transitions: [{ at: -DAY, level: 'warning', reason: 'security' }],
  });
  const third = await addCondition(db.sql, {
    ...common,
    level: 'note',
    raisedAt: -DAY,
    subject: apt('wget'),
  });
  // A group of one, whose last transition is in the future of the migration.
  const lone = await addCondition(db.sql, {
    ...common,
    level: 'note',
    raisedAt: -DAY,
    subject: brew('jq'),
    transitions: [{ at: 20 * 365 * DAY, level: 'warning', reason: 'security' }],
  });
  const other = await addCondition(db.sql, {
    kind: 'pending_update',
    level: 'note',
    raisedAt: -DAY,
    subject: apt('curl'),
    system: 'server-1',
  });
  const history = await addCondition(db.sql, {
    ...common,
    clearedAt: -2 * DAY,
    level: 'note',
    raisedAt: -4 * DAY,
    subject: apt('curl'),
  });
  const before: { condition: string; id: string }[] = await db.sql`
    SELECT condition, id FROM condition_transitions ORDER BY id
  `;

  await migrate(db.sql);

  const conditions: {
    cleared_at: Date | null;
    id: string;
    level: string;
    raised_at: Date;
    subject: string;
    system: string;
  }[] = await db.sql`
    SELECT id, system, subject, level, raised_at, cleared_at FROM conditions ORDER BY id
  `;
  const byId = new Map(conditions.map((row) => [row.id, row]));
  expect(byId.get(first)).toMatchObject({
    cleared_at: null,
    level: 'warning',
    raised_at: new Date(at(-3 * DAY)),
    subject: JSON.stringify(['apt', '/usr/bin/apt']),
  });
  expect(byId.get(lone)).toMatchObject({
    cleared_at: null,
    level: 'warning',
    subject: JSON.stringify(['homebrew', '/opt/hom"ebrew']),
  });
  expect(byId.get(other)).toMatchObject({
    cleared_at: null,
    subject: JSON.stringify(['apt', '/usr/bin/apt']),
  });
  for (const id of [second, third]) {
    expect(byId.get(id)?.cleared_at).not.toBeNull();
    expect(byId.get(id)?.subject).toBe(apt(id === second ? 'openssl' : 'wget'));
  }
  expect(byId.get(history)).toMatchObject({
    cleared_at: new Date(at(-2 * DAY)),
    subject: apt('curl'),
  });

  const transitions: {
    action: string;
    at: Date;
    condition: string;
    id: string;
    level: string;
    previous_level: string | null;
    reason: string;
  }[] = await db.sql`SELECT * FROM condition_transitions ORDER BY id`;
  expect(
    transitions.slice(0, before.length).map(({ condition, id }) => ({ condition, id })),
  ).toEqual(before);
  const added = transitions.slice(before.length);
  const summarize = (id: string) =>
    added
      .filter((row) => row.condition === id)
      .map(({ action, level, previous_level: previous }) => [action, level, previous]);
  expect(summarize(first)).toEqual([['level_changed', 'warning', 'note']]);
  expect(summarize(second)).toEqual([['cleared', 'warning', null]]);
  expect(summarize(third)).toEqual([['cleared', 'note', null]]);
  expect(summarize(lone)).toEqual([]);
  expect(summarize(other)).toEqual([]);
  expect(summarize(history)).toEqual([]);
  const closing = added.filter((row) => row.action === 'cleared');
  expect(closing.map((row) => row.reason)).toEqual([
    'Merged into one Condition for its package source.',
    'Merged into one Condition for its package source.',
  ]);
  // No transition is earlier than the one before it in its occurrence.
  for (const row of added) {
    const earlier = transitions.filter((t) => t.condition === row.condition && t.id < row.id);
    expect(row.at.getTime()).toBeGreaterThanOrEqual(
      Math.max(...earlier.map((t) => t.at.getTime())),
    );
  }
  expect(byId.get(second)?.cleared_at).toEqual(closing.find((row) => row.condition === second)?.at);
});
