import { beforeAll, describe, expect, test } from 'bun:test';

import {
  issue,
  NOW,
  openGeneration,
  push,
  redeem,
  report,
  startHub,
  timeline,
  unpair,
} from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import type { Range } from './fleet-overview-types.ts';
import { findGaps, parseOverviewInput, projectOf, readFleetOverview } from './fleet-overview.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60_000;
const BUCKET = 5 * MINUTE;
const HOUR = 12 * BUCKET;

// Seconds after NOW, as the Hub's fixtures take them.
const { addCondition, addProcess, addSession } = timeline(NOW);
const seconds = (ms: number) => ms / 1000;

const overview = (h: Hub, range: Range = '24h', now = NOW, unpaired = false) =>
  readFleetOverview(h.db.sql, { now, range, unpaired });

// The lane of `name`, which the test has paired.
const lane = async (h: Hub, name: string, now = NOW, range: Range = '24h') => {
  const found = (await overview(h, range, now)).lanes.find((l) => l.name === name);
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

describe('parseOverviewInput', () => {
  test('takes the range of the input, and 24h when it names none', () => {
    expect(parseOverviewInput({ range: '7d' }).range).toBe('7d');
    expect(parseOverviewInput({}).range).toBe('24h');
    expect(parseOverviewInput(undefined).range).toBe('24h');
  });

  test('refuses a range that is not offered', () => {
    expect(() => parseOverviewInput({ range: '3d' })).toThrow('3d');
    expect(() => parseOverviewInput({ range: 24 })).toThrow('24');
  });

  test('asks for unpaired Systems only when the input says so', () => {
    expect(parseOverviewInput({ unpaired: true }).unpaired).toBe(true);
    expect(parseOverviewInput({ unpaired: false }).unpaired).toBe(false);
    expect(parseOverviewInput({}).unpaired).toBe(false);
  });
});

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

describe('buckets', () => {
  test('averages, lows, and highs the CPU of the samples pushed into each 5-minute bucket', async () => {
    await using h = await startHub();
    const times = [NOW - 10 * MINUTE, NOW - 10 * MINUTE + 15_000, NOW - 10 * MINUTE + 30_000];
    await hear(h, 'server-1', { cpu: [10, 40, 25], times });

    const server = await lane(h, 'server-1');

    expect(server.buckets).toEqual([{ average: 25, high: 40, low: 10, t: NOW - 10 * MINUTE }]);
  });

  test('keeps only buckets inside the range', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: [NOW - 7 * HOUR, NOW - 5 * HOUR, NOW - HOUR] });

    const sixHours = await overview(h, '6h');
    const day = await overview(h, '24h');

    const starts = (o: typeof sixHours) => o.lanes[1]?.buckets.map(({ t }) => t);
    expect(starts(sixHours)).toEqual([NOW - 5 * HOUR, NOW - HOUR]);
    expect(starts(day)).toEqual([NOW - 7 * HOUR, NOW - 5 * HOUR, NOW - HOUR]);
    expect([sixHours.from, sixHours.to]).toEqual([NOW - 6 * HOUR, NOW]);
  });
});

describe('gaps', () => {
  test('reports the stretch inside the range where no Vitals arrived, not the bucket still filling', async () => {
    await using h = await startHub();
    const now = NOW + 2 * MINUTE;
    // Vitals in the 6 hours before NOW except one stretch of 3 buckets, and none yet in the bucket holding `now`.
    const times = [];
    for (let t = NOW - 6 * HOUR; t < NOW; t += BUCKET) {
      if (t < NOW - 4 * HOUR || t >= NOW - 4 * HOUR + 3 * BUCKET) {
        times.push(t);
      }
    }
    await hear(h, 'server-1', { receivedAt: now, times });

    const server = await lane(h, 'server-1', now, '6h');

    expect(server.gaps).toEqual([{ from: NOW - 4 * HOUR, to: NOW - 4 * HOUR + 3 * BUCKET }]);
  });
});

describe('status', () => {
  test('is never_seen for a paired System the Hub has not heard from', async () => {
    await using h = await startHub();

    expect((await lane(h, 'laptop-1')).status).toBe('never_seen');
    expect((await lane(h, 'laptop-1')).lastSeenAt).toBeUndefined();
  });

  test('is up for a System heard from just now', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');

    expect((await lane(h, 'server-1')).status).toBe('up');
  });

  test('is asleep for a System that sleeps and has been silent over 2 minutes', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1', { receivedAt: NOW - 3 * MINUTE, sleeps: true });

    const laptop = await lane(h, 'laptop-1');

    expect(laptop.status).toBe('asleep');
    expect(laptop.sleeps).toBe(true);
  });

  test('is up for a System that sleeps and was heard from within 2 minutes', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1', { receivedAt: NOW - MINUTE, sleeps: true });

    expect((await lane(h, 'laptop-1')).status).toBe('up');
  });

  test('is up for an always-on System silent for 3 minutes', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { receivedAt: NOW - 3 * MINUTE, sleeps: false });

    expect((await lane(h, 'server-1')).status).toBe('up');
  });

  test('is needs_you for a System with an open Condition, even one that sleeps and is silent', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1', { receivedAt: NOW - 3 * MINUTE, sleeps: true });
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      raisedAt: seconds(-HOUR),
      system: 'laptop-1',
    });

    expect((await lane(h, 'laptop-1')).status).toBe('needs_you');
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

// Prices `priced-model` at $1 per input token and $2 per output token.
const price = (h: Hub) => h.db.sql`
  INSERT INTO model_prices (
    model, valid_from, source, input_per_mtok, output_per_mtok, context_window
  )
  VALUES ('priced-model', '2020-01-01', 'bundled', 1000000, 2000000, 100000)
`;

describe('stretches', () => {
  test('carries the Session, its project and branch, its cost, and its link to a process', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await price(h);
    await addProcess(h.db.sql, {
      cwd: '/srv/work/api',
      end: -1000,
      pid: 10,
      start: -4000,
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      gitBranch: 'feature/lanes',
      id: 's1',
      lastCwd: '/srv/work/api',
      model: 'priced-model',
      requests: [-3500, -2000],
      system: 'server-1',
    });

    expect((await lane(h, 'server-1')).stretches).toEqual([
      {
        branch: 'feature/lanes',
        costUsd: 10,
        endedAt: NOW - 2000_000,
        harness: 'claude-code',
        link: 'linked',
        project: 'api',
        sessionId: 's1',
        startedAt: NOW - 3500_000,
      },
    ]);
  });

  test("names a stretch's project for the repository its working directory belongs to", async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addProcess(h.db.sql, {
      cwd: '/srv/trees/feature',
      end: -1000,
      pid: 10,
      repository: '/srv/work/api',
      start: -4000,
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      id: 's1',
      lastCwd: '/srv/trees/feature',
      requests: [-3500, -2000],
      system: 'server-1',
    });

    expect((await lane(h, 'server-1')).stretches[0]?.project).toBe('api');
  });

  test("gives each of a Session's stretches the Session's whole cost, keeping sources apart", async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await price(h);
    await addProcess(h.db.sql, { end: -5000, pid: 10, start: -9000, system: 'server-1' });
    await addProcess(h.db.sql, { end: -1000, pid: 12, start: -4000, system: 'server-1' });
    await addSession(h.db.sql, {
      id: 's1',
      model: 'priced-model',
      requests: [-8500, -6000, -3500, -2000],
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      id: 's1',
      model: 'priced-model',
      requests: [-700],
      source: 'other',
      system: 'server-1',
    });

    const stretches = (await lane(h, 'server-1')).stretches;

    expect(stretches.map(({ costUsd, startedAt }) => [startedAt, costUsd])).toEqual([
      [NOW - 8500_000, 20],
      [NOW - 3500_000, 20],
      [NOW - 700_000, 5],
    ]);
  });

  test('is ambiguous when two processes of the Harness in its directory may have run it', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addProcess(h.db.sql, { end: -1000, pid: 10, start: -4000, system: 'server-1' });
    await addProcess(h.db.sql, { end: -1000, pid: 11, start: -4000, system: 'server-1' });
    await addSession(h.db.sql, { id: 's1', requests: [-3500, -2000], system: 'server-1' });

    expect((await lane(h, 'server-1')).stretches[0]?.link).toBe('ambiguous');
  });

  test('has no cost for a Session with an unpriced request, and no project or branch it never recorded', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addSession(h.db.sql, { id: 's1', requests: [-3500, -2000], system: 'server-1' });

    const [stretch] = (await lane(h, 'server-1')).stretches;

    expect(stretch).toMatchObject({
      branch: undefined,
      costUsd: undefined,
      link: 'unmatched',
      project: 'my-project',
    });
  });

  test('leaves out stretches that end before the range, start after it, or ran on another System', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    const day = 24 * 3600;
    await addSession(h.db.sql, {
      id: 'before',
      requests: [-day - 600, -day - 60],
      system: 'server-1',
    });
    await addSession(h.db.sql, { id: 'after', requests: [60, 600], system: 'server-1' });
    await addSession(h.db.sql, { id: 'elsewhere', requests: [-600, -60], system: 'laptop-1' });
    await addSession(h.db.sql, {
      id: 'straddles',
      requests: [-day - 600, -day + 600],
      system: 'server-1',
    });

    const stretches = (await lane(h, 'server-1')).stretches.map(({ sessionId }) => sessionId);

    expect(stretches).toEqual(['straddles']);
  });
});

describe('conditions', () => {
  test('includes a level change in the range when its occurrence was raised before the range', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      level: 'note',
      raisedAt: -2 * 86_400,
      subject: '/',
      system: 'server-1',
      transitions: [{ at: -1800, level: 'alert', reason: '90% used' }],
    });
    const marks = (await lane(h, 'server-1', NOW, '6h')).conditions;
    expect(marks).toMatchObject([
      {
        level: 'alert',
        transitions: [
          { at: NOW - 2 * 86_400_000, kind: 'raised', level: 'note' },
          { at: NOW - 1800_000, kind: 'level_changed', level: 'alert' },
        ],
      },
    ]);
  });

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

  test('marks those raised or cleared inside the range, with the times that fall outside it', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await hear(h, 'laptop-1');
    const day = 24 * 3600;
    const db = h.db.sql;
    await addCondition(db, {
      clearedAt: -day / 2,
      kind: 'service_down',
      raisedAt: -2 * day,
      subject: 'a',
      system: 'server-1',
    });
    await addCondition(db, {
      clearedAt: -day - 60,
      kind: 'service_down',
      raisedAt: -2 * day,
      subject: 'b',
      system: 'server-1',
    });
    await addCondition(db, { kind: 'drift', raisedAt: -3600, system: 'server-1' });
    await addCondition(db, { kind: 'low_disk', raisedAt: -3600, system: 'laptop-1' });

    const marks = (await lane(h, 'server-1')).conditions;

    expect(marks).toMatchObject([
      {
        clearedAt: NOW - (day / 2) * 1000,
        kind: 'service_down',
        level: 'alert',
        raisedAt: NOW - 2 * day * 1000,
        subject: 'a',
      },
      {
        clearedAt: undefined,
        kind: 'drift',
        level: 'warning',
        raisedAt: NOW - 3600_000,
        subject: '',
      },
    ]);
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

  test('leaves out Conditions on a System that was unpaired', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, { kind: 'low_disk', raisedAt: -600, system: 'server-1' });
    await unpair(h.db.sql, 'server-1');

    expect((await overview(h)).attention).toEqual([]);
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

    const found = await overview(h, '24h', NOW, true);

    expect(found.lanes.map(({ name }) => name)).toEqual(['server-1']);
    expect(found.unpairedLanes).toMatchObject([
      {
        buckets: [{ average: 42, t: NOW - 10 * MINUTE }],
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

  test('put their Conditions after the paired Systems, each group newest raised first', async () => {
    await using h = await startHub();
    await unpairedLaptop(h);
    await addCondition(h.db.sql, { kind: 'drift', raisedAt: -7200, system: 'server-1' });
    await addCondition(h.db.sql, { kind: 'drift', raisedAt: -60, system: 'laptop-1' });

    const { attention } = await overview(h, '24h', NOW, true);

    expect(attention.map(({ system, unpaired }) => [system, unpaired])).toEqual([
      ['server-1', false],
      ['laptop-1', true],
      ['laptop-1', true],
    ]);
    expect(attention.map(({ firstDetected }) => NOW - firstDetected)).toEqual([
      7200_000, 60_000, 3600_000,
    ]);
  });

  test('do not include a paired System that was never seen', async () => {
    await using h = await startHub();

    const found = await overview(h, '24h', NOW, true);

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

    const found = await overview(h, '24h', NOW, true);

    expect(found.lanes).toEqual([]);
    expect(found.unpairedCount).toBe(2);
    expect(found.unpairedLanes.map(({ name }) => name)).toEqual(['laptop-1', 'server-1']);
  });

  test('are paired again by redeeming a new code, and not before', async () => {
    await using h = await startHub();
    await unpairedLaptop(h);

    const code = await issue(h, 'laptop-1');
    expect((await overview(h)).lanes.map(({ name }) => name)).toEqual(['server-1']);

    expect((await redeem(h.hub, { code })).status).toBe(200);
    const found = await overview(h);
    expect(found.lanes.map(({ name }) => name)).toEqual(['laptop-1', 'server-1']);
    expect(found.unpairedCount).toBe(0);
  });
});

describe('last seen', () => {
  test('moves on a Report the Hub rejects', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1');

    h.clock.now = NOW + 12 * MINUTE;
    expect((await push(h.hub, { system: 'laptop-1' }, { token: 'laptop-token' })).status).toBe(422);

    expect((await lane(h, 'laptop-1')).lastSeenAt).toBe(NOW + 12 * MINUTE);
  });

  test('moves on a transcript upload, even from a System that has sent no Report', async () => {
    await using h = await startHub();
    h.clock.now = NOW + MINUTE;

    const opened = await openGeneration(
      h.hub,
      { path: 'my-project/0b1c.jsonl', source: 'claude-code' },
      { token: 'laptop-token' },
    );
    expect(opened.status).toBe(201);

    expect((await lane(h, 'laptop-1')).lastSeenAt).toBe(NOW + MINUTE);
  });

  test('moves on an upload the Hub refuses', async () => {
    await using h = await startHub();
    h.clock.now = NOW + MINUTE;

    await openGeneration(h.hub, '{', { token: 'laptop-token' });

    expect((await lane(h, 'laptop-1')).lastSeenAt).toBe(NOW + MINUTE);
  });

  test('moves on a Report of samples the Hub already holds', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1');

    await hear(h, 'laptop-1', { receivedAt: NOW + 60 * MINUTE, times: [NOW] });

    expect((await lane(h, 'laptop-1', NOW + 60 * MINUTE)).lastSeenAt).toBe(NOW + 60 * MINUTE);
  });

  test('does not move back for a Report the Hub clock places earlier', async () => {
    await using h = await startHub();
    await hear(h, 'laptop-1');

    await hear(h, 'laptop-1', { receivedAt: NOW - 60 * MINUTE, times: [NOW + 15_000] });

    expect((await lane(h, 'laptop-1')).lastSeenAt).toBe(NOW);
  });
});

describe('delivery status', () => {
  test('carries when the Hub began failing to deliver alerts, and none while delivery works', async () => {
    await using h = await startHub();
    expect((await overview(h)).deliveryFailingSince).toBeUndefined();

    await h.db.sql`UPDATE delivery_status SET failing_since = ${new Date(NOW - 30 * MINUTE)}`;

    expect((await overview(h)).deliveryFailingSince).toBe(NOW - 30 * MINUTE);
  });

  test('is carried when no System is paired, and changes neither the lanes nor the attention', async () => {
    await using h = await startHub();
    const before = await overview(h);
    await h.db.sql`UPDATE delivery_status SET failing_since = ${new Date(NOW - 30 * MINUTE)}`;

    const failing = await overview(h);

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

    const found = await overview(h, '24h', NOW, true);

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
