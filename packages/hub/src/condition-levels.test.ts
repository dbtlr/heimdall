import { expect, test } from 'bun:test';

import { clear, raise } from './conditions.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';

test('a level change retains the occurrence, orders history across clock reversal, and records no reason-only transition', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  const judge = (level: 'note' | 'warning' | 'alert', offset: number, reason: string) =>
    h.db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM systems WHERE name = 'laptop-1' FOR UPDATE`;
      await raise(tx, {
        kind: 'low_disk',
        level,
        now: new Date(NOW + offset),
        reason,
        subject: '/',
        system: 'laptop-1',
      });
    });

  await judge('note', 1000, '70% used');
  await judge('alert', 2000, '92% used');
  await judge('alert', 3000, '93% used');
  await judge('warning', 0, '82% used');
  await h.db.sql.begin((tx) =>
    clear(tx, { kind: 'low_disk', now: new Date(NOW), subject: '/', system: 'laptop-1' }),
  );

  const conditions: {
    level: string;
    raised_at: Date;
    latest_reason: string;
    cleared_at: Date | null;
  }[] = await h.db.sql`SELECT level, raised_at, latest_reason, cleared_at FROM conditions`;
  expect(conditions).toEqual([
    {
      cleared_at: new Date(NOW + 2000),
      latest_reason: '82% used',
      level: 'warning',
      raised_at: new Date(NOW + 1000),
    },
  ]);
  const events: {
    action: string;
    level: string;
    previous_level: string | null;
    at: Date;
    reason: string;
    backfilled: boolean;
  }[] = await h.db
    .sql`SELECT action, level, previous_level, at, reason, backfilled FROM condition_transitions ORDER BY id`;
  expect(events).toEqual([
    {
      action: 'raised',
      at: new Date(NOW + 1000),
      backfilled: false,
      level: 'note',
      previous_level: null,
      reason: '70% used',
    },
    {
      action: 'level_changed',
      at: new Date(NOW + 2000),
      backfilled: false,
      level: 'alert',
      previous_level: 'note',
      reason: '92% used',
    },
    {
      action: 'level_changed',
      at: new Date(NOW + 2000),
      backfilled: false,
      level: 'warning',
      previous_level: 'alert',
      reason: '82% used',
    },
    {
      action: 'cleared',
      at: new Date(NOW + 2000),
      backfilled: false,
      level: 'warning',
      previous_level: null,
      reason: '82% used',
    },
  ]);
});

test('a refused transition rolls back the current level and reason with it', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  const judge = (level: 'note' | 'alert') =>
    h.db.sql.begin(async (tx) => {
      await tx`SELECT 1 FROM systems WHERE name = 'laptop-1' FOR UPDATE`;
      await raise(tx, {
        kind: 'low_disk',
        level,
        now: new Date(NOW),
        reason: level,
        subject: '/',
        system: 'laptop-1',
      });
    });
  await judge('note');
  await h.db.sql.unsafe(`
    CREATE FUNCTION refuse_transition() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'transition refused'; END $$;
    CREATE TRIGGER refuse_transition BEFORE INSERT ON condition_transitions
      FOR EACH ROW EXECUTE FUNCTION refuse_transition();
  `);

  const failure = await judge('alert').then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({ message: 'transition refused' });

  const conditions: { level: string; latest_reason: string }[] = await h.db
    .sql`SELECT level, latest_reason FROM conditions`;
  const events: { action: string; level: string }[] = await h.db
    .sql`SELECT action, level FROM condition_transitions`;
  expect(conditions).toEqual([{ latest_reason: 'note', level: 'note' }]);
  expect(events).toEqual([{ action: 'raised', level: 'note' }]);
});
