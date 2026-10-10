import { describe, expect, test } from 'bun:test';

import type { Report } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { migrate, MIGRATIONS } from './migrations.ts';
import { listSystems } from './store.ts';
import { evaluateSystemConditions, SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import type { SystemConditionThresholds } from './system-conditions.ts';
import { NOW, openGeneration, page, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;
const GIB = 2 ** 30;

// laptop-1 and server-1 were paired at NOW; this reads laptop-1 unless told otherwise.
const tokenOf = (system: string) => (system === 'laptop-1' ? 'laptop-token' : 'server-token');

// A disk of `totalGib` GiB with `freePercent` of it free.
const disk = (mount: string, freePercent: number, totalGib = 100) => ({
  mount,
  totalBytes: totalGib * GIB,
  usedBytes: Math.round(totalGib * GIB * (1 - freePercent / 100)),
});

// Sends a Report received at `time` with one sample carrying `disks`, and
// `sleeps` when given.
const send = async (
  h: Hub,
  time: number,
  {
    disks = [disk('/', 50)],
    sleeps,
    system = 'laptop-1',
  }: { disks?: ReturnType<typeof disk>[]; sleeps?: boolean; system?: string } = {},
) => {
  h.clock.now = time;
  const base = report(system, [time]);
  const body: Report = {
    ...base,
    samples: [{ ...sample(time), disks }],
    sentAt: time,
    ...(sleeps === undefined ? {} : { sleeps }),
  };
  expect((await push(h.hub, body, { token: tokenOf(system) })).status).toBe(200);
};

// A Report the Hub rejects, received at `time`.
const sendRejected = async (h: Hub, time: number, system = 'laptop-1') => {
  h.clock.now = time;
  expect((await push(h.hub, { system }, { token: tokenOf(system) })).status).toBe(422);
};

const evaluate = (
  h: Hub,
  time: number,
  thresholds: SystemConditionThresholds = SYSTEM_CONDITION_THRESHOLDS,
) => {
  h.clock.now = time;
  return evaluateSystemConditions(h.db.sql, () => h.clock.now, thresholds);
};

// A System's open Conditions and Timeline.
const conditionsOf = async (h: Hub, system = 'laptop-1') => {
  const found = (await listSystems(h.db.sql)).find((s) => s.name === system);
  return { open: found?.conditions ?? [], timeline: found?.timeline ?? [] };
};

const kinds = (conditions: { kind: string }[]) => conditions.map((c) => c.kind);

describe('stale System', () => {
  test('is raised once a System was last seen more than 10 minutes ago, and not before', async () => {
    await using h = await startHub();
    const seen = NOW + MINUTE;
    await send(h, seen);

    await evaluate(h, seen + 10 * MINUTE);
    expect((await conditionsOf(h)).open).toEqual([]);

    await evaluate(h, seen + 10 * MINUTE + SECOND);
    expect((await conditionsOf(h)).open).toEqual([
      {
        kind: 'system_stale',
        raisedAt: seen + 10 * MINUTE + SECOND,
        reason: 'Not heard from since 2026-10-06 12:01 UTC, more than 10 minutes ago.',
        subject: '',
      },
    ]);
  });

  test('is raised after 7 days for a System that sleeps, and not before', async () => {
    await using h = await startHub();
    const seen = NOW + MINUTE;
    await send(h, seen, { sleeps: true });

    await evaluate(h, seen + 7 * DAY);
    expect((await conditionsOf(h)).open).toEqual([]);

    await evaluate(h, seen + 7 * DAY + SECOND);
    expect((await conditionsOf(h)).open).toEqual([
      expect.objectContaining({
        kind: 'system_stale',
        reason: 'Not heard from since 2026-10-06 12:01 UTC, more than 7 days ago.',
      }),
    ]);
  });

  test('stays one Condition while the System stays silent', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await evaluate(h, NOW + 11 * MINUTE);

    await evaluate(h, NOW + 12 * MINUTE);
    await evaluate(h, NOW + 5 * DAY);

    const { open, timeline } = await conditionsOf(h);
    expect(open).toEqual([expect.objectContaining({ raisedAt: NOW + 11 * MINUTE })]);
    expect(timeline).toHaveLength(1);
  });

  test('clears when the System reports again, and the Timeline keeps both', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await evaluate(h, NOW + 11 * MINUTE);

    await send(h, NOW + 12 * MINUTE);
    await evaluate(h, NOW + 13 * MINUTE);

    const { open, timeline } = await conditionsOf(h);
    expect(open).toEqual([]);
    expect(timeline).toEqual([
      { at: NOW + 13 * MINUTE, condition: 'system_stale', kind: 'cleared', subject: '' },
      expect.objectContaining({ at: NOW + 11 * MINUTE, condition: 'system_stale', kind: 'raised' }),
    ]);
  });

  test('clears when the System is heard from through a rejected Report', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await evaluate(h, NOW + 11 * MINUTE);

    await sendRejected(h, NOW + 12 * MINUTE);
    await evaluate(h, NOW + 13 * MINUTE);

    expect(kinds((await conditionsOf(h)).open)).toEqual(['reports_rejected']);
  });

  test('clears when the System is heard from through a transcript upload', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await evaluate(h, NOW + 11 * MINUTE);

    h.clock.now = NOW + 12 * MINUTE;
    const opened = await openGeneration(
      h.hub,
      { path: 'my-project/0b1c.jsonl', source: 'claude-code' },
      { token: 'laptop-token' },
    );
    expect(opened.status).toBe(201);
    await evaluate(h, NOW + 13 * MINUTE);

    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('a System that went quiet again after reporting is raised again, as a new Condition', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await evaluate(h, NOW + 11 * MINUTE);
    await send(h, NOW + 12 * MINUTE);
    await evaluate(h, NOW + 13 * MINUTE);

    await evaluate(h, NOW + 23 * MINUTE);

    const { open, timeline } = await conditionsOf(h);
    expect(open).toEqual([expect.objectContaining({ raisedAt: NOW + 23 * MINUTE })]);
    expect(timeline).toHaveLength(3);
  });

  test('a paired System never seen counts from pairing, and shows with the Condition', async () => {
    await using h = await startHub();

    await evaluate(h, NOW + 10 * MINUTE);
    expect(await listSystems(h.db.sql)).toEqual([]);

    await evaluate(h, NOW + 10 * MINUTE + SECOND);
    const { open } = await conditionsOf(h);
    expect(open).toEqual([
      expect.objectContaining({
        kind: 'system_stale',
        reason:
          'Not heard from since it was paired at 2026-10-06 12:00 UTC, more than 10 minutes ago.',
      }),
    ]);
    // The page shows the System, with no Vitals and no Collector build.
    expect(await page(h.hub)).toContain('System stale');
  });

  test('a paired System that reports after being flagged never seen clears', async () => {
    await using h = await startHub();
    await evaluate(h, NOW + 11 * MINUTE);

    await send(h, NOW + 12 * MINUTE);
    await evaluate(h, NOW + 13 * MINUTE);

    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('a System paired again counts from the new pairing', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await h.db
      .sql`UPDATE paired_systems SET paired_at = ${new Date(NOW + DAY)} WHERE system = 'laptop-1'`;

    await evaluate(h, NOW + DAY + 5 * MINUTE);

    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('judges every paired System, not only those with records', async () => {
    await using h = await startHub();
    await send(h, NOW, { system: 'laptop-1' });
    await send(h, NOW, { system: 'server-1' });
    await send(h, NOW + 20 * MINUTE, { system: 'server-1' });

    await evaluate(h, NOW + 21 * MINUTE);

    expect(kinds((await conditionsOf(h, 'laptop-1')).open)).toEqual(['system_stale']);
    expect((await conditionsOf(h, 'server-1')).open).toEqual([]);
  });

  test('a Report without sleeps keeps what the Hub holds, and one with it replaces it', async () => {
    await using h = await startHub();
    await send(h, NOW, { sleeps: true });
    await send(h, NOW + DAY);

    await evaluate(h, NOW + DAY + 2 * DAY);
    expect((await conditionsOf(h)).open).toEqual([]);

    await send(h, NOW + 3 * DAY, { sleeps: false });
    await evaluate(h, NOW + 3 * DAY + 11 * MINUTE);
    expect(kinds((await conditionsOf(h)).open)).toEqual(['system_stale']);
  });

  test('a System that never sent sleeps is always on', async () => {
    await using h = await startHub();
    await send(h, NOW);

    await evaluate(h, NOW + 11 * MINUTE);

    expect(kinds((await conditionsOf(h)).open)).toEqual(['system_stale']);
  });

  test('uses the thresholds it is given', async () => {
    await using h = await startHub();
    await send(h, NOW);
    const patient = { ...SYSTEM_CONDITION_THRESHOLDS, staleAfterMs: 2 * DAY };

    await evaluate(h, NOW + DAY, patient);
    expect((await conditionsOf(h)).open).toEqual([]);
    await evaluate(h, NOW + 3 * DAY, patient);
    expect(kinds((await conditionsOf(h)).open)).toEqual(['system_stale']);
  });
});

describe('low disk', () => {
  test('is raised for a mount below 10% free, with the free space and percentage', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 9.9)] });

    await evaluate(h, NOW + MINUTE);

    expect((await conditionsOf(h)).open).toEqual([
      {
        kind: 'low_disk',
        raisedAt: NOW + MINUTE,
        reason: '9.9 GiB free of 100.0 GiB (9.9%).',
        subject: '/',
      },
    ]);
  });

  test('is not raised at exactly 10% free', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 10)] });

    await evaluate(h, NOW + MINUTE);

    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('is not raised for a mount that has been between 10% and 15% free all along', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 12)] });

    await evaluate(h, NOW + MINUTE);

    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('is held between 10% and 15% free and clears above 15%', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 5)] });
    await evaluate(h, NOW + MINUTE);

    await send(h, NOW + 2 * MINUTE, { disks: [disk('/', 12)] });
    await evaluate(h, NOW + 3 * MINUTE);
    expect(kinds((await conditionsOf(h)).open)).toEqual(['low_disk']);

    await send(h, NOW + 4 * MINUTE, { disks: [disk('/', 15)] });
    await evaluate(h, NOW + 5 * MINUTE);
    expect(kinds((await conditionsOf(h)).open)).toEqual(['low_disk']);

    await send(h, NOW + 6 * MINUTE, { disks: [disk('/', 15.1)] });
    await evaluate(h, NOW + 7 * MINUTE);
    const { open, timeline } = await conditionsOf(h);
    expect(open).toEqual([]);
    expect(timeline).toEqual([
      { at: NOW + 7 * MINUTE, condition: 'low_disk', kind: 'cleared', subject: '/' },
      expect.objectContaining({ at: NOW + MINUTE, condition: 'low_disk', kind: 'raised' }),
    ]);
  });

  test('takes the new free space as its reason while the mount stays low', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 9)] });
    await evaluate(h, NOW + MINUTE);

    await send(h, NOW + 2 * MINUTE, { disks: [disk('/', 4)] });
    await evaluate(h, NOW + 3 * MINUTE);

    expect((await conditionsOf(h)).open).toEqual([
      expect.objectContaining({
        raisedAt: NOW + MINUTE,
        reason: '4.0 GiB free of 100.0 GiB (4.0%).',
      }),
    ]);
  });

  test('is judged per mount, with the mount as the subject', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 50), disk('/data', 3), disk('/boot', 8, 1)] });

    await evaluate(h, NOW + MINUTE);

    expect((await conditionsOf(h)).open).toEqual([
      expect.objectContaining({
        kind: 'low_disk',
        reason: '3.0 GiB free of 100.0 GiB (3.0%).',
        subject: '/data',
      }),
      expect.objectContaining({
        kind: 'low_disk',
        reason: '81.9 MiB free of 1.0 GiB (8.0%).',
        subject: '/boot',
      }),
    ]);
  });

  test('clears when the mount leaves the samples', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 50), disk('/data', 3)] });
    await evaluate(h, NOW + MINUTE);

    await send(h, NOW + 2 * MINUTE, { disks: [disk('/', 50)] });
    await evaluate(h, NOW + 3 * MINUTE);

    const { open, timeline } = await conditionsOf(h);
    expect(open).toEqual([]);
    expect(timeline[0]).toEqual({
      at: NOW + 3 * MINUTE,
      condition: 'low_disk',
      kind: 'cleared',
      subject: '/data',
    });
  });

  test('a mount with no size is neither raised nor cleared', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [{ mount: '/proc', totalBytes: 0, usedBytes: 0 }] });
    await evaluate(h, NOW + MINUTE);
    expect((await conditionsOf(h)).open).toEqual([]);

    await send(h, NOW + 2 * MINUTE, { disks: [disk('/', 1), disk('/data', 1)] });
    await evaluate(h, NOW + 3 * MINUTE);
    await send(h, NOW + 4 * MINUTE, { disks: [{ mount: '/data', totalBytes: 0, usedBytes: 0 }] });
    await evaluate(h, NOW + 5 * MINUTE);

    expect((await conditionsOf(h)).open.map((c) => c.subject)).toEqual(['/data']);
  });

  test('a mount used past its size is out of space', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [{ mount: '/', totalBytes: 100, usedBytes: 120 }] });

    await evaluate(h, NOW + MINUTE);

    expect((await conditionsOf(h)).open).toEqual([
      expect.objectContaining({ reason: '0 B free of 100 B (0.0%).' }),
    ]);
  });

  test('uses the thresholds it is given', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 30)] });
    const tight = { ...SYSTEM_CONDITION_THRESHOLDS, lowDiskBelow: 0.4, lowDiskClearAbove: 0.5 };

    await evaluate(h, NOW + MINUTE, tight);

    expect(kinds((await conditionsOf(h)).open)).toEqual(['low_disk']);
  });

  test('a System with no samples has nothing to judge', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 1)] });
    await evaluate(h, NOW + MINUTE);
    await h.db.sql`DELETE FROM vitals_samples`;

    await evaluate(h, NOW + 2 * MINUTE);

    expect(kinds((await conditionsOf(h)).open)).toEqual(['low_disk']);
  });
});

test('the page and the Timeline name the Condition and the mount', async () => {
  await using h = await startHub();
  await send(h, NOW, { disks: [disk('/data', 2)] });
  await evaluate(h, NOW + 11 * MINUTE);

  const html = await page(h.hub);

  expect(html).toContain('<strong>System stale</strong> since');
  expect(html).toContain('<strong>Low disk</strong> <code>/data</code> since');
  expect(html).toContain('Low disk <code>/data</code>:');
});

test('a System that cannot be judged does not stop the others, and the failure names it', async () => {
  await using h = await startHub();
  await send(h, NOW, { system: 'laptop-1' });
  await send(h, NOW, { system: 'server-1' });
  // The database refuses laptop-1's Conditions.
  await h.db.sql.unsafe(`
    CREATE FUNCTION refuse_laptop() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'refused'; END $$;
    CREATE TRIGGER refuse_laptop BEFORE INSERT ON conditions
      FOR EACH ROW WHEN (NEW.system = 'laptop-1') EXECUTE FUNCTION refuse_laptop();
  `);

  const failure = await evaluate(h, NOW + 11 * MINUTE).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({ message: expect.stringContaining('laptop-1: refused') });
  expect(kinds((await conditionsOf(h, 'server-1')).open)).toEqual(['system_stale']);
});

test('migration 10 leaves what a System sleeps as unknown for Systems already stored', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 9),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;

  expect(
    await migrate(
      db.sql,
      MIGRATIONS.filter((m) => m.version <= 10),
    ),
  ).toEqual([10]);

  const [row]: { sleeps: boolean | null }[] = await db.sql`SELECT sleeps FROM systems`;
  expect(row?.sleeps).toBeNull();
});
