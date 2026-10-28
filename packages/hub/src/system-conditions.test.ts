import { describe, expect, test } from 'bun:test';

import { sample } from '@heimdall/schema/testing';

import { recordListening } from './listening.ts';
import { migrate, MIGRATIONS } from './migrations.ts';
import { unpair } from './pairing.ts';
import {
  evaluateSystem,
  evaluateSystemConditions,
  judgeSystemConditions,
  SYSTEM_CONDITION_THRESHOLDS,
} from './system-conditions.ts';
import type { SystemConditionFacts, SystemConditionThresholds } from './system-conditions.ts';
import { listSystems, NOW, openGeneration, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';
import { storeToken } from './tokens.ts';

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
    sampleAt = time,
    sleeps,
    system = 'laptop-1',
  }: {
    disks?: ReturnType<typeof disk>[];
    sampleAt?: number;
    sleeps?: boolean | string;
    system?: string;
  } = {},
) => {
  h.clock.now = time;
  const base = report(system, [sampleAt]);
  const body = {
    ...base,
    samples: [{ ...sample(sampleAt), disks }],
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

// The Hub records that it is listening every 30 seconds from `from` through `to`.
const listen = async (h: Hub, from: number, to: number) => {
  for (let at = from; at <= to; at += 30 * SECOND) {
    // oxlint-disable-next-line no-await-in-loop -- one moment after another.
    await recordListening(h.db.sql, at);
  }
};

// A System's open Conditions and Timeline.
const conditionsOf = async (h: Hub, system = 'laptop-1') => {
  const found = (await listSystems(h.db.sql)).find((s) => s.name === system);
  return { open: found?.conditions ?? [], timeline: found?.timeline ?? [] };
};

const kinds = (conditions: { kind: string }[]) => conditions.map((c) => c.kind);

const systemFacts = (overrides: Partial<SystemConditionFacts> = {}): SystemConditionFacts => ({
  diskLimits: SYSTEM_CONDITION_THRESHOLDS.disk,
  lastSeenAt: NOW,
  latest: undefined,
  listeningSince: undefined,
  open: [],
  pairedAt: NOW,
  sleeps: false,
  ...overrides,
});

const judge = (facts = systemFacts(), now = NOW, thresholds = SYSTEM_CONDITION_THRESHOLDS) =>
  judgeSystemConditions(facts, now, thresholds);

describe('stale System', () => {
  test('is raised once a System was last seen more than 10 minutes ago, and not before', () => {
    const facts = systemFacts({ lastSeenAt: NOW + MINUTE });
    expect(judge(facts, NOW + 11 * MINUTE).stale).toBe('clear');
    expect(judge(facts, NOW + 11 * MINUTE + SECOND).stale).toEqual({
      raise: 'Not heard from since 2026-10-06 12:01 UTC, more than 10 minutes ago.',
    });
  });

  test('is raised after 7 days for a System that sleeps, and not before', () => {
    const facts = systemFacts({ lastSeenAt: NOW + MINUTE, sleeps: true });
    expect(judge(facts, NOW + MINUTE + 7 * DAY).stale).toBe('clear');
    expect(judge(facts, NOW + MINUTE + 7 * DAY + SECOND).stale).toEqual({
      raise: 'Not heard from since 2026-10-06 12:01 UTC, more than 7 days ago.',
    });
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

  test('is not raised for time the Hub was not listening, only once it has listened past the limit', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await listen(h, NOW, NOW + 5 * MINUTE);

    // An hour-long outage: the Hub listens again from NOW + 65 minutes.
    await listen(h, NOW + 65 * MINUTE, NOW + 75 * MINUTE);
    await evaluate(h, NOW + 75 * MINUTE);
    expect((await conditionsOf(h)).open).toEqual([]);

    await listen(h, NOW + 75 * MINUTE + SECOND, NOW + 75 * MINUTE + SECOND);
    await evaluate(h, NOW + 75 * MINUTE + SECOND);
    expect((await conditionsOf(h)).open).toEqual([
      expect.objectContaining({
        kind: 'system_stale',
        reason: 'Not heard from since 2026-10-06 12:00 UTC, more than 10 minutes ago.',
      }),
    ]);
  });

  test('a System that sleeps waits only 10 minutes after an outage, not its own limit', async () => {
    await using h = await startHub();
    await send(h, NOW, { sleeps: true });
    await listen(h, NOW, NOW + 5 * MINUTE);

    // The Hub is down from NOW + 5 minutes to NOW + 8 days.
    await listen(h, NOW + 8 * DAY, NOW + 8 * DAY + 10 * MINUTE);
    await evaluate(h, NOW + 8 * DAY + 10 * MINUTE);
    expect((await conditionsOf(h)).open).toEqual([]);

    await listen(h, NOW + 8 * DAY + 10 * MINUTE + SECOND, NOW + 8 * DAY + 10 * MINUTE + SECOND);
    await evaluate(h, NOW + 8 * DAY + 10 * MINUTE + SECOND);
    expect(kinds((await conditionsOf(h)).open)).toEqual(['system_stale']);
  });

  test('a gap in listening of up to 2 minutes, such as a quick restart, does not restart the count', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await listen(h, NOW, NOW + 5 * MINUTE);
    await listen(h, NOW + 7 * MINUTE, NOW + 11 * MINUTE);

    await evaluate(h, NOW + 11 * MINUTE);

    expect(kinds((await conditionsOf(h)).open)).toEqual(['system_stale']);
  });

  test('is not raised by a judgment that comes back from an outage before the Hub records it', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await listen(h, NOW, NOW + 5 * MINUTE);

    await evaluate(h, NOW + 30 * MINUTE);
    expect((await conditionsOf(h)).open).toEqual([]);

    await listen(h, NOW + 30 * MINUTE + SECOND, NOW + 40 * MINUTE + SECOND);
    await evaluate(h, NOW + 40 * MINUTE + 2 * SECOND);
    expect(kinds((await conditionsOf(h)).open)).toEqual(['system_stale']);
  });

  test('a Hub clock that ran a day ahead and was corrected holds for no longer than 10 minutes', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await listen(h, NOW, NOW + MINUTE);
    await recordListening(h.db.sql, NOW + DAY);

    await listen(h, NOW + MINUTE + 30 * SECOND, NOW + 12 * MINUTE);
    await evaluate(h, NOW + 12 * MINUTE);

    expect(kinds((await conditionsOf(h)).open)).toEqual(['system_stale']);
  });

  test('stays open through a Hub outage, and clears only once the System is heard from', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await listen(h, NOW, NOW + 11 * MINUTE);
    await evaluate(h, NOW + 11 * MINUTE);

    await listen(h, NOW + 3 * 60 * MINUTE, NOW + 3 * 60 * MINUTE);
    await evaluate(h, NOW + 3 * 60 * MINUTE);
    const held = await conditionsOf(h);
    expect(held.open).toEqual([expect.objectContaining({ raisedAt: NOW + 11 * MINUTE })]);
    expect(held.timeline).toHaveLength(1);

    await send(h, NOW + 3 * 60 * MINUTE + MINUTE);
    await evaluate(h, NOW + 3 * 60 * MINUTE + 2 * MINUTE);
    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('clears when the System reports again, the Timeline keeps both, and a later silence raises a new Condition', async () => {
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

    await evaluate(h, NOW + 23 * MINUTE);

    const again = await conditionsOf(h);
    expect(again.open).toEqual([expect.objectContaining({ raisedAt: NOW + 23 * MINUTE })]);
    expect(again.timeline).toHaveLength(3);
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

  test('a paired System never seen counts from pairing, and has no last seen', async () => {
    await using h = await startHub();

    await evaluate(h, NOW + 10 * MINUTE);
    expect(await listSystems(h.db.sql)).toEqual([]);

    await evaluate(h, NOW + 10 * MINUTE + SECOND);
    const [laptop] = await listSystems(h.db.sql);
    expect(laptop?.lastSeenAt).toBeUndefined();
    expect(laptop?.conditions).toEqual([
      expect.objectContaining({
        kind: 'system_stale',
        reason:
          'Not heard from since it was paired at 2026-10-06 12:00 UTC, more than 10 minutes ago.',
      }),
    ]);
  });

  test('a System flagged never seen takes its real Last seen from its first Report, and clears', async () => {
    await using h = await startHub();
    await evaluate(h, NOW + 11 * MINUTE);

    await send(h, NOW + 12 * MINUTE);
    await evaluate(h, NOW + 13 * MINUTE);

    const [laptop] = await listSystems(h.db.sql);
    expect(laptop?.lastSeenAt).toBe(NOW + 12 * MINUTE);
    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('a System paired again stays stale until it is heard from', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await evaluate(h, NOW + 11 * MINUTE);

    await storeToken(h.db.sql, {
      pairedAt: NOW + 12 * MINUTE,
      system: 'laptop-1',
      token: 'laptop-token',
    });
    await evaluate(h, NOW + 13 * MINUTE);
    expect(kinds((await conditionsOf(h)).open)).toEqual(['system_stale']);

    await send(h, NOW + 14 * MINUTE);
    await evaluate(h, NOW + 15 * MINUTE);
    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('a System never seen and paired again counts from the new pairing', async () => {
    await using h = await startHub();
    await storeToken(h.db.sql, { pairedAt: NOW + DAY, system: 'laptop-1', token: 'new-token' });

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

  test('a Report whose sleeps is not a boolean is stored, and keeps what the Hub holds', async () => {
    await using h = await startHub();
    await send(h, NOW, { sleeps: true });

    await send(h, NOW + DAY, { sleeps: 'sometimes' });

    await evaluate(h, NOW + DAY + 2 * DAY);
    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('uses the thresholds it is given', () => {
    const patient = { ...SYSTEM_CONDITION_THRESHOLDS, staleAfterMs: 2 * DAY };
    expect(judge(systemFacts(), NOW + DAY, patient).stale).toBe('clear');
    expect(judge(systemFacts(), NOW + 3 * DAY, patient).stale).toEqual({
      raise: 'Not heard from since 2026-10-06 12:00 UTC, more than 2 days ago.',
    });
  });
});

describe('a System that is no longer paired', () => {
  test('has its stale System and low disk Conditions cleared, and is judged no more', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 2)] });
    await evaluate(h, NOW + 11 * MINUTE);
    expect(kinds((await conditionsOf(h)).open).toSorted()).toEqual(['low_disk', 'system_stale']);

    await unpair(h.db.sql, 'laptop-1');
    await evaluate(h, NOW + 12 * MINUTE);

    const { open, timeline } = await conditionsOf(h);
    expect(open).toEqual([]);
    expect(timeline.filter((entry) => entry.kind === 'cleared')).toEqual([
      { at: NOW + 12 * MINUTE, condition: 'low_disk', kind: 'cleared', subject: '/' },
      { at: NOW + 12 * MINUTE, condition: 'system_stale', kind: 'cleared', subject: '' },
    ]);

    await evaluate(h, NOW + 30 * MINUTE);
    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('keeps the Conditions other kinds raised', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await sendRejected(h, NOW + MINUTE);
    await evaluate(h, NOW + 12 * MINUTE);
    expect(kinds((await conditionsOf(h)).open).toSorted()).toEqual([
      'reports_rejected',
      'system_stale',
    ]);

    await unpair(h.db.sql, 'laptop-1');
    await evaluate(h, NOW + 13 * MINUTE);

    expect(kinds((await conditionsOf(h)).open)).toEqual(['reports_rejected']);
  });

  // The path a System takes when it is unpaired between being listed and judged.
  test('is cleared by judging it directly, and a name the Hub holds nothing for is left alone', async () => {
    await using h = await startHub();
    await send(h, NOW);
    await evaluate(h, NOW + 11 * MINUTE);
    await unpair(h.db.sql, 'laptop-1');

    for (const system of ['laptop-1', 'ghost']) {
      // oxlint-disable-next-line no-await-in-loop -- one System after the other.
      await evaluateSystem(h.db.sql, system, () => NOW + 12 * MINUTE, SYSTEM_CONDITION_THRESHOLDS);
    }

    expect((await conditionsOf(h)).open).toEqual([]);
    expect((await listSystems(h.db.sql)).map((s) => s.name)).not.toContain('ghost');
  });
});

describe('low disk', () => {
  test('old Vitals do not lower an open disk level or clear a missing mount', () => {
    expect(
      judge(
        systemFacts({
          latest: { disks: [disk('/', 50)], old: true },
          open: [
            { level: 'alert', subject: '/' },
            { level: 'alert', subject: '/data' },
          ],
        }),
      ).disks,
    ).toEqual(new Map());
    expect(
      judge(
        systemFacts({
          latest: { disks: [disk('/', 5)], old: true },
          open: [{ level: 'note', subject: '/' }],
        }),
      ).disks.get('/'),
    ).toEqual({ level: 'alert', raise: '5.0 GiB free of 100.0 GiB (5.0%).' });
  });

  test('grades each boundary through hysteresis and direct jumps', () => {
    let open: SystemConditionFacts['open'] = [];
    const observed = [69, 70, 79, 80, 89, 90, 85, 84, 75, 74, 65, 64, 92, 72, 64].map((used) => {
      const verdict = judge(
        systemFacts({
          latest: { disks: [{ mount: '/', totalBytes: 1000, usedBytes: used * 10 }], old: false },
          open,
        }),
      ).disks.get('/');
      if (verdict === undefined || verdict === 'hold') {
        throw new Error('Expected a disk judgment.');
      }
      open = verdict === 'clear' ? [] : [{ level: verdict.level, subject: '/' }];
      return verdict === 'clear' ? null : verdict.level;
    });
    expect(observed).toEqual([
      null,
      'note',
      'note',
      'warning',
      'warning',
      'alert',
      'alert',
      'warning',
      'warning',
      'note',
      'note',
      null,
      'alert',
      'note',
      null,
    ]);
  });

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

  test('is judged per mount, with the mount as the subject', () => {
    expect(
      judge(
        systemFacts({
          latest: { disks: [disk('/', 50), disk('/data', 3), disk('/boot', 8, 1)], old: false },
        }),
      ).disks,
    ).toEqual(
      new Map<string, 'clear' | { level: 'alert'; raise: string }>([
        ['/', 'clear'],
        ['/data', { level: 'alert', raise: '3.0 GiB free of 100.0 GiB (3.0%).' }],
        ['/boot', { level: 'alert', raise: '81.9 MiB free of 1.0 GiB (8.0%).' }],
      ]),
    );
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

  test('a mount with no size is neither raised nor cleared', () => {
    const latest = { disks: [{ mount: '/data', totalBytes: 0, usedBytes: 0 }], old: false };
    expect(judge(systemFacts({ latest })).disks.get('/data')).toBe('hold');
    expect(
      judge(
        systemFacts({
          latest,
          open: [
            { level: 'alert', subject: '/' },
            { level: 'alert', subject: '/data' },
          ],
        }),
      ).disks,
    ).toEqual(
      new Map([
        ['/data', 'hold'],
        ['/', 'clear'],
      ]),
    );
  });

  test('a mount used past its size is out of space', () => {
    expect(
      judge(
        systemFacts({
          latest: {
            disks: [{ mount: '/', totalBytes: 100, usedBytes: 120 }],
            old: false,
          },
        }),
      ).disks.get('/'),
    ).toEqual({ level: 'alert', raise: '0 B free of 100 B (0.0%).' });
  });

  test('judges the latest sample stamped within 5 minutes of the Hub clock, not one stamped far ahead', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 5)], sampleAt: NOW + DAY });
    await send(h, NOW + MINUTE, { disks: [disk('/', 5)] });
    await evaluate(h, NOW + 2 * MINUTE);
    expect(kinds((await conditionsOf(h)).open)).toEqual(['low_disk']);

    await send(h, NOW + 3 * MINUTE, { disks: [disk('/', 50)] });
    await evaluate(h, NOW + 4 * MINUTE);

    expect((await conditionsOf(h)).open).toEqual([]);
  });

  test('counts a sample stamped a little ahead of the Hub clock', async () => {
    await using h = await startHub();
    await send(h, NOW, { disks: [disk('/', 5)], sampleAt: NOW + 4 * MINUTE });

    await evaluate(h, NOW + MINUTE);

    expect(kinds((await conditionsOf(h)).open)).toEqual(['low_disk']);
  });

  test('judges the lowest free space of a mount listed twice, whatever its order', () => {
    const tight = disk('/', 5);
    const loose = disk('/', 50);
    const sizeless = { mount: '/', totalBytes: 0, usedBytes: 0 };
    for (const disks of [
      [tight, loose],
      [loose, tight],
      [sizeless, tight],
      [tight, sizeless],
      [disk('/', 5, 50), tight],
      [tight, disk('/', 5, 50)],
    ]) {
      const verdict = judge(systemFacts({ latest: { disks, old: false } })).disks.get('/');
      expect(verdict).toMatchObject({ level: 'alert' });
      expect(verdict).toEqual({
        level: 'alert',
        raise: disks.some((d) => d.totalBytes === 50 * GIB)
          ? '2.5 GiB free of 50.0 GiB (5.0%).'
          : '5.0 GiB free of 100.0 GiB (5.0%).',
      });
    }
  });

  test('uses the thresholds it is given', () => {
    expect(
      judge(
        systemFacts({
          diskLimits: { alert: 90, hysteresis: 5, note: 60, warning: 75 },
          latest: { disks: [disk('/', 30)], old: false },
        }),
      ).disks.get('/'),
    ).toMatchObject({ level: 'note' });
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

test('stale judgment holds through outage grace, but hearing from the System clears it', () => {
  const facts = systemFacts({ listeningSince: NOW + DAY });
  expect(judge(facts, NOW + DAY + 10 * MINUTE).stale).toBe('hold');
  expect(judge(facts, NOW + DAY + 10 * MINUTE + 1).stale).toHaveProperty('raise');
  expect(judge({ ...facts, lastSeenAt: NOW + DAY }, NOW + DAY + MINUTE).stale).toBe('clear');
});

test('missing readable Vitals leave disk Conditions alone while pairing supplies never-seen age', () => {
  const facts = systemFacts({ lastSeenAt: undefined, open: [{ level: 'alert', subject: '/' }] });
  expect(judge(facts, NOW + 11 * MINUTE)).toEqual({
    disks: new Map(),
    stale: {
      raise:
        'Not heard from since it was paired at 2026-10-06 12:00 UTC, more than 10 minutes ago.',
    },
  });
});
