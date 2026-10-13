import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import type { Range } from './fleet-overview-types.ts';
import { findGaps, parseRangeInput, readFleetOverview } from './fleet-overview.ts';

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

const overview = (h: Hub, range: Range = '24h', now = NOW) =>
  readFleetOverview(h.db.sql, { now, range, timeZone: 'UTC' });

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

describe('parseRangeInput', () => {
  test('takes the range of the input, and 24h when it names none', () => {
    expect(parseRangeInput({ range: '7d' })).toBe('7d');
    expect(parseRangeInput({})).toBe('24h');
    expect(parseRangeInput(undefined)).toBe('24h');
  });

  test('refuses a range that is not offered', () => {
    expect(() => parseRangeInput({ range: '3d' })).toThrow('3d');
    expect(() => parseRangeInput({ range: 24 })).toThrow('24');
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
      memoryUsedPercent: 37.5, // 12 GiB of 32 GiB
      t: NOW - MINUTE,
    });
  });

  test('is undefined for a System with no samples', async () => {
    await using h = await startHub();

    expect((await lane(h, 'laptop-1')).latest).toBeUndefined();
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

    expect(marks).toEqual([
      {
        clearedAt: NOW - (day / 2) * 1000,
        kind: 'service_down',
        raisedAt: NOW - 2 * day * 1000,
        subject: 'a',
      },
      { clearedAt: undefined, kind: 'drift', raisedAt: NOW - 3600_000, subject: '' },
    ]);
  });
});

describe('open', () => {
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

    const { open } = await overview(h);

    expect(open).toEqual([
      {
        kind: 'job_failing',
        raisedAt: NOW - 600_000,
        reason: 'backup failed',
        subject: 'backup',
        system: 'server-1',
      },
      {
        kind: 'low_disk',
        raisedAt: NOW - 7200_000,
        reason: 'disk 95% full',
        subject: '',
        system: 'laptop-1',
      },
    ]);
  });

  test('leaves out Conditions on a System that was unpaired', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');
    await addCondition(h.db.sql, { kind: 'low_disk', raisedAt: -600, system: 'server-1' });
    await unpair(h.db.sql, 'server-1');

    expect((await overview(h)).open).toEqual([]);
  });
});
