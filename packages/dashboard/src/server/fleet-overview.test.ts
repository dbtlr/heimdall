import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { findGaps, laneStatus, projectOf, readFleetGlance } from './fleet-overview.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60_000;
const BUCKET = 5 * MINUTE;
const HOUR = 12 * BUCKET;

// Seconds after NOW, as the Hub's fixtures take them.
const { addCondition } = timeline(NOW);
const seconds = (ms: number) => ms / 1000;

const overview = (h: Hub, now = NOW, unpaired = false) =>
  readFleetGlance(h.db.sql, { now, unpaired });

// The lane of `name`, which the test has paired.
const lane = async (h: Hub, name: string, now = NOW) => {
  const found = (await overview(h, now)).lanes.find((l) => l.name === name);
  if (found === undefined) {
    throw new Error(`no lane for ${name}`);
  }
  return found;
};

// Sends one Report from `system` as the Hub receives it at `receivedAt`; the
// sample at index i is `cpu[i]` percent busy when given.
const hear = async (
  h: Hub,
  system: string,
  {
    cpu = [],
    receivedAt = NOW,
    sleeps,
    times = [receivedAt],
  }: { cpu?: number[]; receivedAt?: number; sleeps?: boolean; times?: number[] } = {},
) => {
  h.clock.now = receivedAt;
  const sent = report(system, times);
  for (const [i, busyPercent] of cpu.entries()) {
    const sample = sent.samples[i];
    if (sample !== undefined) {
      sample.cpu = { busyPercent };
    }
  }
  const response = await push(
    h.hub,
    { ...sent, sleeps },
    { token: `${system.split('-')[0]}-token` },
  );
  expect(response.status).toBe(200);
};

describe('projectOf', () => {
  test("names a project by its repository's last folder, else its working directory's", () => {
    expect(projectOf('/srv/work/api/', '/srv/trees/feature')).toBe('api');
    expect(projectOf(null, '/srv/trees/feature')).toBe('feature');
    expect(projectOf(null, null)).toBeUndefined();
  });

  test('falls back to the working directory when the repository has no folder name', () => {
    expect(projectOf('/', '/notes')).toBe('notes');
  });
});

describe('findGaps', () => {
  // Bucket starts are epoch milliseconds, aligned to 5 minutes.
  const from = NOW - 6 * HOUR;

  test('finds no gap when every bucket of the range has Vitals', () => {
    const present = Array.from({ length: 72 }, (_, i) => from + i * BUCKET);

    expect(findGaps(present, { from, now: NOW })).toEqual([]);
  });

  test('merges neighbouring missing buckets into one gap ending at the last one', () => {
    const present = Array.from({ length: 72 }, (_, i) => from + i * BUCKET).filter(
      (t) => t < NOW - 3 * HOUR || t >= NOW - 3 * HOUR + 3 * BUCKET,
    );

    expect(findGaps(present, { from, now: NOW })).toEqual([
      { from: NOW - 3 * HOUR, to: NOW - 3 * HOUR + 3 * BUCKET },
    ]);
  });

  test('finds a gap at the start of the range and one at the end, before the in-progress bucket', () => {
    const present = [from + 2 * BUCKET, from + 3 * BUCKET];

    expect(findGaps(present, { from, now: NOW + 2 * MINUTE })).toEqual([
      { from, to: from + 2 * BUCKET },
      { from: from + 4 * BUCKET, to: NOW },
    ]);
  });

  test('starts at the bucket holding `from`', () => {
    expect(findGaps([], { from: from + MINUTE, now: from + 2 * BUCKET })).toEqual([
      { from, to: from + 2 * BUCKET },
    ]);
  });
});

describe('status', () => {
  test('is asleep for a System that sleeps and has been silent over 2 minutes', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1', { receivedAt: NOW - 3 * MINUTE, sleeps: true });

    const laptop = await lane(h, 'laptop-1');

    expect(laptop.status).toBe('asleep');
    expect(laptop.sleeps).toBe(true);
  });

  test('is not needs_you for a System whose Conditions are all cleared', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      clearedAt: seconds(-HOUR / 2),
      kind: 'service_down',
      raisedAt: seconds(-HOUR),
      system: 'server-1',
    });

    expect((await lane(h, 'server-1')).status).toBe('up');
  });
});

describe('laneStatus', () => {
  const base = { hasOpenCondition: false, lastSeenAt: NOW, now: NOW, paired: true, sleeps: false };

  test('reads a sleeping System as up until it has been silent over 2 minutes, and an always-on one as up however long', () => {
    expect(laneStatus({ ...base, lastSeenAt: NOW - 2 * MINUTE, sleeps: true })).toBe('up');
    expect(laneStatus({ ...base, lastSeenAt: NOW - 2 * MINUTE - 1, sleeps: true })).toBe('asleep');
    expect(laneStatus({ ...base, lastSeenAt: NOW - 3 * MINUTE })).toBe('up');
  });

  test('reads an unpaired System as unpaired, even one never seen or with an open Condition', () => {
    expect(laneStatus({ ...base, paired: false })).toBe('unpaired');
    expect(laneStatus({ ...base, lastSeenAt: undefined, paired: false })).toBe('unpaired');
    expect(laneStatus({ ...base, hasOpenCondition: true, paired: false })).toBe('unpaired');
  });

  test('reads a paired System never seen as never_seen, even with an open Condition', () => {
    expect(laneStatus({ ...base, lastSeenAt: undefined })).toBe('never_seen');
    expect(laneStatus({ ...base, hasOpenCondition: true, lastSeenAt: undefined })).toBe(
      'never_seen',
    );
  });

  test('reads an open Condition as needs_you over asleep and up', () => {
    expect(laneStatus({ ...base, hasOpenCondition: true })).toBe('needs_you');
    expect(
      laneStatus({ ...base, hasOpenCondition: true, lastSeenAt: NOW - 3 * MINUTE, sleeps: true }),
    ).toBe('needs_you');
  });
});

describe('latest', () => {
  test('is the newest Vitals sample, with memory as a percent', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { cpu: [30], times: [NOW - 10 * MINUTE] });
    await hear(h, 'server-1', { cpu: [70], times: [NOW - MINUTE] });

    expect((await lane(h, 'server-1')).latest).toEqual({
      cpuBusyPercent: 70,
      disks: [{ mount: '/System/Volumes/Data', totalBytes: 994662584320, usedBytes: 412316860416 }],
      memoryUsedPercent: 37.5, // 12 GiB of 32 GiB
      t: NOW - MINUTE,
    });
  });

  test('is undefined for a System with no samples', async () => {
    await using h = await startHub();

    expect((await lane(h, 'laptop-1')).latest).toBeUndefined();
  });

  test('preserves unknown memory use when a sample reports no capacity', async () => {
    await using h = await startHub();
    const sent = report('server-1', [NOW]);
    const sample = sent.samples[0];
    if (sample === undefined) {
      throw new Error('fixture has no sample');
    }
    sample.memory = { totalBytes: 0, usedBytes: 0 };
    expect((await push(h.hub, sent, { token: 'server-token' })).status).toBe(200);
    expect((await lane(h, 'server-1')).latest?.memoryUsedPercent).toBeUndefined();
  });
});

describe('notes', () => {
  test('notes stay visible without making a System need you, while an old alert still does', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: [NOW - 3 * HOUR] });
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      level: 'note',
      raisedAt: -3600,
      subject: '/',
      system: 'server-1',
    });

    const notes = await overview(h);
    expect(notes.lanes.find(({ name }) => name === 'server-1')?.status).toBe('up');
    expect(notes.attention.find(({ kind }) => kind === 'low_disk')?.level).toBe('note');

    await addCondition(h.db.sql, {
      kind: 'low_disk',
      level: 'alert',
      raisedAt: -300,
      subject: '/data',
      system: 'server-1',
    });
    const alerts = await overview(h);
    expect(alerts.lanes.find(({ name }) => name === 'server-1')?.status).toBe('needs_you');
    expect(alerts.attention.find(({ kind }) => kind === 'low_disk')).toMatchObject({
      evidence: 'old',
      level: 'alert',
    });
  });
});

describe('attention', () => {
  test('lists open Conditions on paired Systems, newest raised first, with their latest reason', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    const db = h.db.sql;
    await addCondition(db, {
      kind: 'low_disk',
      raisedAt: -7200,
      reason: 'disk 95% full',
      system: 'laptop-1',
    });
    await addCondition(db, {
      kind: 'job_failing',
      raisedAt: -600,
      reason: 'backup failed',
      subject: 'backup',
      system: 'server-1',
    });
    await addCondition(db, { clearedAt: -60, kind: 'drift', raisedAt: -300, system: 'server-1' });

    const { attention } = await overview(h);

    expect(attention).toMatchObject([
      {
        firstDetected: NOW - 600_000,
        kind: 'job_failing',
        subject: 'backup',
        system: 'server-1',
        unpaired: false,
      },
      {
        firstDetected: NOW - 7200_000,
        kind: 'low_disk',
        reason: 'disk 95% full',
        subject: '',
        system: 'laptop-1',
        unpaired: false,
      },
    ]);
  });
});

// `laptop-1` has reported and has an open Condition, then is unpaired.
const unpairedLaptop = async (h: Hub) => {
  await hear(h, 'server-1');
  await hear(h, 'laptop-1', { cpu: [42], times: [NOW - 10 * MINUTE] });
  await addCondition(h.db.sql, {
    kind: 'low_disk',
    raisedAt: -3600,
    reason: 'disk 95% full',
    subject: '/',
    system: 'laptop-1',
  });
  await unpair(h.db.sql, 'laptop-1');
};

describe('unpaired Systems', () => {
  test('are counted but left out of the lanes and Open now until asked for', async () => {
    await using h = await startHub();
    await unpairedLaptop(h);

    const found = await overview(h);

    expect(found.lanes.map(({ name }) => name)).toEqual(['server-1']);
    expect(found.unpairedLanes).toEqual([]);
    expect(found.unpairedCount).toBe(1);
    expect(found.attention).toEqual([]);
  });

  test('keep their history and show as Unpaired, with their open Conditions, when asked for', async () => {
    await using h = await startHub();
    await unpairedLaptop(h);

    const found = await overview(h, NOW, true);

    expect(found.lanes.map(({ name }) => name)).toEqual(['server-1']);
    expect(found.unpairedLanes).toMatchObject([
      {
        lastSeenAt: NOW,
        latest: { cpuBusyPercent: 42, t: NOW - 10 * MINUTE },
        name: 'laptop-1',
        status: 'unpaired',
      },
    ]);
    expect(found.unpairedCount).toBe(1);
    expect(found.attention).toMatchObject([
      {
        firstDetected: NOW - 3600_000,
        kind: 'low_disk',
        reason: 'disk 95% full',
        subject: '/',
        system: 'laptop-1',
        unpaired: true,
      },
    ]);
  });

  test('do not include a paired System that was never seen', async () => {
    await using h = await startHub();

    const found = await overview(h, NOW, true);

    expect(found.unpairedCount).toBe(0);
    expect(found.unpairedLanes).toEqual([]);
    expect(found.lanes.map(({ name, status }) => [name, status])).toEqual([
      ['laptop-1', 'never_seen'],
      ['server-1', 'never_seen'],
    ]);
  });

  test('count every System, and keep the lanes empty when none is paired', async () => {
    await using h = await startHub();
    await unpairedLaptop(h);
    await unpair(h.db.sql, 'server-1');

    const found = await overview(h, NOW, true);

    expect(found.lanes).toEqual([]);
    expect(found.unpairedCount).toBe(2);
    expect(found.unpairedLanes.map(({ name }) => name)).toEqual(['laptop-1', 'server-1']);
  });
});

describe('delivery status', () => {
  test('carries when the Hub began failing to deliver alerts, changes neither the lanes nor the attention, and survives unpairing every System', async () => {
    await using h = await startHub();
    expect((await overview(h)).deliveryFailingSince).toBeUndefined();
    const before = await overview(h);

    await h.db.sql`UPDATE delivery_status SET failing_since = ${new Date(NOW - 30 * MINUTE)}`;

    const failing = await overview(h);
    expect(failing.deliveryFailingSince).toBe(NOW - 30 * MINUTE);
    expect(failing.lanes).toEqual(before.lanes);
    expect(failing.attention).toEqual(before.attention);
    await unpair(h.db.sql, 'server-1');
    await unpair(h.db.sql, 'laptop-1');
    expect((await overview(h)).deliveryFailingSince).toBe(NOW - 30 * MINUTE);
  });
});

const silence = (h: Hub, system: string, until: number) =>
  h.db.sql`
    INSERT INTO silences (system, until, created_at)
    VALUES (${system}, ${new Date(until)}, ${new Date(NOW - HOUR)})
  `;

describe('silences', () => {
  test('carry the end of an active silence on that System only', async () => {
    await using h = await startHub();
    await silence(h, 'server-1', NOW + 2 * HOUR);

    expect((await lane(h, 'server-1')).silencedUntil).toBe(NOW + 2 * HOUR);
    expect((await lane(h, 'laptop-1')).silencedUntil).toBeUndefined();
  });

  test('are ignored once they end, though the row remains', async () => {
    await using h = await startHub();
    await silence(h, 'server-1', NOW);
    await silence(h, 'laptop-1', NOW - MINUTE);

    expect((await lane(h, 'server-1')).silencedUntil).toBeUndefined();
    expect((await lane(h, 'laptop-1')).silencedUntil).toBeUndefined();
    expect((await lane(h, 'server-1', NOW - MINUTE)).silencedUntil).toBe(NOW);
  });

  test('end when the System is unpaired', async () => {
    await using h = await startHub();
    await silence(h, 'server-1', NOW + 2 * HOUR);
    await unpair(h.db.sql, 'server-1');

    const found = await overview(h, NOW, true);

    expect(found.unpairedLanes.map((l) => l.silencedUntil)).toEqual([undefined]);
  });

  test('change nothing in the overview beyond the silence itself', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      level: 'alert',
      raisedAt: -3600,
      subject: '/',
      system: 'server-1',
    });
    const before = await overview(h);

    await silence(h, 'server-1', NOW + 2 * HOUR);
    const silenced = await overview(h);

    const expected = structuredClone(before);
    const server = expected.lanes.find((l) => l.name === 'server-1');
    if (server !== undefined) {
      server.silencedUntil = NOW + 2 * HOUR;
    }
    expect(silenced).toEqual(expected);
    expect(silenced.lanes.find((l) => l.name === 'server-1')?.status).toBe('needs_you');
  });
});
