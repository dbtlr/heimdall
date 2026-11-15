// The System page over 30 d and 1 y: Vitals re-binned from the 5-minute
// rollups, Harness process CPU from their rollups, cost per bucket, reboots,
// and the bucket the inspector reads.

import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { parseBucketInput, readBucket, readSystemDetail } from './system-detail.ts';

beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const BUCKET = 5 * MINUTE;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;

const { addCondition, addProcess, addSession } = timeline(NOW);

// NOW is noon UTC, so a day bucket starts 12 hours before it.
const TODAY = NOW - 12 * HOUR;

const hear = async (h: Hub, system = 'server-1') => {
  h.clock.now = NOW;
  const response = await push(h.hub, report(system, [NOW]), {
    token: `${system.split('-')[0]}-token`,
  });
  expect(response.status).toBe(200);
};

type Rollup = {
  cpu: [number, number, number];
  load: [number, number, number];
  // GiB used: lowest, sum over samples, highest.
  memory: [number, number, number];
  samples: number;
  t: number;
  uptimeMin?: number;
};

// Stores 5-minute Vitals rollups of server-1 as the Hub's ingest leaves them.
const storeRollups = async (h: Hub, rollups: readonly Rollup[]) => {
  for (const { cpu, load, memory, samples, t, uptimeMin = 86_400 } of rollups) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of fixture rows.
    await h.db.sql`
      INSERT INTO vitals_rollups (
        system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max, memory_used_min,
        memory_used_sum, memory_used_max, memory_total_max, load_1_min, load_1_sum, load_1_max,
        uptime_min, collector_cpu_sum, collector_cpu_max, collector_rss_sum, collector_rss_max
      )
      VALUES ('server-1', ${new Date(t)}, ${samples}, ${cpu[0]}, ${cpu[1]}, ${cpu[2]},
              ${memory[0] * GIB}, ${memory[1] * GIB}, ${memory[2] * GIB}, ${32 * GIB},
              ${load[0]}, ${load[1]}, ${load[2]}, ${uptimeMin}, 0, 0, 0, 0)
      ON CONFLICT (system, bucket) DO UPDATE SET uptime_min = excluded.uptime_min
    `;
  }
};

const flat = (t: number, uptimeMin?: number): Rollup => ({
  cpu: [10, 200, 10],
  load: [1, 20, 1],
  memory: [8, 160, 8],
  samples: 20,
  t,
  ...(uptimeMin === undefined ? {} : { uptimeMin }),
});

const price = (h: Hub) => h.db.sql`
  INSERT INTO model_prices (
    model, valid_from, source, input_per_mtok, output_per_mtok, context_window
  )
  VALUES ('priced-model', '2020-01-01', 'bundled', 1000000, 2000000, 100000)
`;

const detail = async (h: Hub, range: '30d' | '1y' | '7d') => {
  const found = await readSystemDetail(h.db.sql, { name: 'server-1', now: NOW, range });
  if (found === undefined) {
    throw new Error('no detail for server-1');
  }
  return found;
};

describe('the System page over 30 d and 1 y', () => {
  test('bins the 5-minute rollups into 3-hour buckets at 30 d: average, low, and high', async () => {
    await using h = await startHub();
    await hear(h);
    const start = NOW - 10 * DAY;
    await storeRollups(h, [
      { cpu: [5, 200, 40], load: [0.5, 20, 2], memory: [4, 120, 8], samples: 20, t: start },
      {
        cpu: [10, 600, 80],
        load: [1, 60, 7],
        memory: [6, 200, 12],
        samples: 20,
        t: start + 2 * HOUR,
      },
      // The next 3-hour bucket.
      flat(start + 3 * HOUR),
    ]);

    const found = await detail(h, '30d');

    expect(found.bucketMs).toBe(3 * HOUR);
    expect(found.cpu.slice(0, 2)).toEqual([
      { average: 20, high: 80, low: 5, t: start },
      { average: 10, high: 10, low: 10, t: start + 3 * HOUR },
    ]);
    expect(found.memory[0]).toEqual({
      highBytes: 12 * GIB,
      lowBytes: 4 * GIB,
      t: start,
      totalBytes: 32 * GIB,
      usedBytes: 8 * GIB,
    });
    expect(found.load[0]).toEqual({ high: 7, low: 0.5, t: start, value: 2 });
    // A day with no rollup at all is a gap, measured in buckets.
    expect(found.gaps).toContainEqual({ from: NOW - 30 * DAY, to: start });
  });

  test('bins into day buckets at 1 y, and keeps 5-minute buckets up to 7 d', async () => {
    await using h = await startHub();
    await hear(h);
    await storeRollups(h, [flat(TODAY - 100 * DAY), flat(TODAY - 100 * DAY + 23 * HOUR)]);
    await storeRollups(h, [flat(NOW - HOUR), flat(NOW - HOUR + BUCKET)]);

    const year = await detail(h, '1y');
    const week = await detail(h, '7d');

    expect(year.bucketMs).toBe(DAY);
    expect(year.cpu.map(({ t }) => t)).toEqual([TODAY - 100 * DAY, TODAY]);
    expect(week.bucketMs).toBe(BUCKET);
    expect(week.long).toBeUndefined();
    expect(week.cpu.map(({ t }) => t)).toEqual([NOW - HOUR, NOW - HOUR + BUCKET]);
  });

  test('a 1 y read returns at most a few hundred points per series from a full year of rollups', async () => {
    await using h = await startHub();
    await hear(h);
    // A year of 5-minute rollups: 105,120 rows.
    await h.db.sql`
      INSERT INTO vitals_rollups (
        system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max, memory_used_min,
        memory_used_sum, memory_used_max, memory_total_max, load_1_min, load_1_sum, load_1_max,
        uptime_min, collector_cpu_sum, collector_cpu_max, collector_rss_sum, collector_rss_max
      )
      SELECT 'server-1', b, 20, 1, 200, 30, 1, 20, 1, 4, 0.1, 2, 0.5, 86400, 0, 0, 0, 0
      FROM generate_series(${new Date(NOW - 365 * DAY)}::timestamptz, ${new Date(NOW - BUCKET)}::timestamptz,
                           interval '5 minutes') AS b
      ON CONFLICT DO NOTHING
    `;
    // A Harness process that ran all year, with its readings rolled up.
    const [process]: { id: string }[] = await h.db.sql`
      INSERT INTO harness_processes (
        system, harness, pid, started_at, cwd, peak_rss_bytes, last_seen_at, sent_at
      )
      VALUES ('server-1', 'claude-code', 10, ${new Date(NOW - 366 * DAY)}, '/srv/work/api', 0,
              ${new Date(NOW)}, ${new Date(NOW)})
      RETURNING id
    `;
    await h.db.sql`
      INSERT INTO harness_process_rollups
        (process, bucket, samples, cpu_micros_min, cpu_micros_max, rss_min, rss_sum, rss_max)
      SELECT ${process?.id}, b, 20, n * 1000000, n * 1000000 + 999999, 1, 20, 1
      FROM generate_series(${new Date(NOW - 365 * DAY)}::timestamptz, ${new Date(NOW - BUCKET)}::timestamptz,
                           interval '5 minutes') WITH ORDINALITY AS g (b, n)
    `;

    const found = await detail(h, '1y');

    const series = {
      cpu: found.cpu.length,
      load: found.load.length,
      memory: found.memory.length,
      process: found.processes[0]?.points.length ?? 0,
    };
    for (const points of Object.values(series)) {
      expect(points).toBeGreaterThan(300);
      expect(points).toBeLessThanOrEqual(366);
    }
    expect(found.gaps).toHaveLength(0);
  }, 60_000);

  test('reads Harness process CPU from the process rollups, since the raw readings are pruned after 14 days', async () => {
    await using h = await startHub();
    await hear(h);
    // 1.5 cores for nearly a 3-hour bucket 20 days ago, its raw readings gone.
    const start = -20 * 86_400;
    await addProcess(h.db.sql, {
      cpuCores: 1.5,
      cwd: '/srv/work/api',
      end: start + 3 * 3600 - 15,
      pid: 10,
      readings: 'rollups',
      start,
      system: 'server-1',
    });

    const { processes } = await detail(h, '30d');

    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({ harness: 'claude-code', pid: 10, project: 'api' });
    expect(processes[0]?.points).toHaveLength(1);
    expect(processes[0]?.points[0]?.t).toBe(NOW - 20 * DAY);
    expect(processes[0]?.points[0]?.cores).toBeCloseTo(1.5, 2);
  });

  test('counts cost per day by Harness: a Session within a day at its total, one across midnight by request', async () => {
    await using h = await startHub();
    await hear(h);
    await hear(h, 'laptop-1');
    await price(h);
    // $5 a request.
    await addSession(h.db.sql, {
      id: 's1',
      model: 'priced-model',
      requests: [-3 * 86_400 - 3600, -3 * 86_400 - 1800],
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      harness: 'codex',
      id: 's2',
      model: 'priced-model',
      requests: [-12 * 3600 - 60, -12 * 3600 + 60],
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      id: 's3',
      model: 'priced-model',
      requests: [-3 * 86_400],
      system: 'laptop-1',
    });

    const { long } = await detail(h, '30d');

    expect(long?.costBucketMs).toBe(DAY);
    expect(long?.costs).toEqual([
      { costUsd: 10, harness: 'claude-code', t: TODAY - 3 * DAY, unpriced: 0 },
      { costUsd: 5, harness: 'codex', t: TODAY - DAY, unpriced: 0 },
      { costUsd: 5, harness: 'codex', t: TODAY, unpriced: 0 },
    ]);
    expect(long?.sessions).toBe(2);
  });

  test('finds each reboot in the rollups: uptime under 5 minutes and below the rollup before', async () => {
    await using h = await startHub();
    await hear(h);
    const boot = NOW - 40 * DAY;
    await storeRollups(h, [
      flat(boot - BUCKET, 500_000),
      flat(boot, 100),
      // The same boot, still under 5 minutes up.
      flat(boot + BUCKET, 250),
      flat(boot + 2 * BUCKET, 550),
    ]);

    const { long } = await detail(h, '1y');

    expect(long?.reboots).toEqual([boot]);
  });
});

describe('readBucket', () => {
  test('inspects the day a 1 y pin falls in: its Vitals, reboot, cost, Sessions, processes, and Conditions', async () => {
    await using h = await startHub();
    await hear(h);
    await price(h);
    const day = TODAY - 20 * DAY;
    await storeRollups(h, [
      { cpu: [2, 200, 30], load: [0.5, 20, 2], memory: [4, 120, 8], samples: 20, t: day },
      {
        cpu: [10, 600, 94],
        load: [1, 60, 7.9],
        memory: [6, 200, 12],
        samples: 20,
        t: day + 3 * HOUR,
        uptimeMin: 120,
      },
      // The day after.
      flat(day + DAY),
    ]);
    const daySeconds = (day - NOW) / 1000;
    await addProcess(h.db.sql, {
      cpuCores: 1,
      cwd: '/srv/work/api',
      end: daySeconds + 2 * 3600,
      pid: 10,
      readings: 'rollups',
      rssBytes: GIB,
      start: daySeconds,
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      id: 's1',
      lastCwd: '/srv/work/api',
      model: 'priced-model',
      requests: [daySeconds + 600, daySeconds + 1200],
      system: 'server-1',
    });
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      level: 'note',
      raisedAt: daySeconds + 3600,
      subject: '/data',
      system: 'server-1',
    });
    await addCondition(h.db.sql, {
      clearedAt: daySeconds - 3600,
      kind: 'high_cpu',
      raisedAt: daySeconds - 7200,
      system: 'server-1',
    });

    const found = await readBucket(h.db.sql, {
      at: day + 15 * HOUR,
      name: 'server-1',
      now: NOW,
      range: '1y',
    });

    expect(found).toMatchObject({
      bucketMs: DAY,
      conditions: [{ kind: 'low_disk', level: 'note', subject: '/data' }],
      costUsd: 10,
      cpu: { average: 20, high: 94, low: 2 },
      load1: { average: 2, high: 7.9, low: 0.5 },
      memory: { average: 8 * GIB, high: 12 * GIB, low: 4 * GIB, totalBytes: 32 * GIB },
      rebootedAt: day + 3 * HOUR,
      rollups: 2,
      samplesPruned: true,
      sessions: 1,
      t: day,
      unpricedRequests: 0,
    });
    expect(found?.processes).toHaveLength(1);
    expect(found?.processes[0]).toMatchObject({
      harness: 'claude-code',
      peakRssBytes: GIB,
      pid: 10,
      project: 'api',
      sessions: 1,
    });
    expect(found?.processes[0]?.cpuHours).toBeCloseTo(2, 2);
  });

  test('inspects a 3-hour bucket at 30 d, and knows a recent one still has its samples', async () => {
    await using h = await startHub();
    await hear(h);
    const bucket = NOW - 2 * DAY;
    await storeRollups(h, [flat(bucket + HOUR)]);

    const found = await readBucket(h.db.sql, {
      at: bucket + 2 * HOUR,
      name: 'server-1',
      now: NOW,
      range: '30d',
    });

    expect(found).toMatchObject({
      bucketMs: 3 * HOUR,
      cpu: { average: 10, high: 10, low: 10 },
      rebootedAt: undefined,
      rollups: 1,
      samplesPruned: false,
      t: bucket,
    });
  });

  test('inspects an empty bucket with no Vitals, and its newest bucket when no time is pinned', async () => {
    await using h = await startHub();
    await hear(h);

    const empty = await readBucket(h.db.sql, {
      at: NOW - 100 * DAY,
      name: 'server-1',
      now: NOW,
      range: '1y',
    });
    const newest = await readBucket(h.db.sql, {
      at: undefined,
      name: 'server-1',
      now: NOW,
      range: '1y',
    });

    expect(empty).toMatchObject({ cpu: undefined, rollups: 0, t: TODAY - 100 * DAY });
    expect(newest?.t).toBe(TODAY);
  });

  test('answers nothing for a name that is no System', async () => {
    await using h = await startHub();

    expect(
      await readBucket(h.db.sql, { at: NOW, name: 'nas-1', now: NOW, range: '1y' }),
    ).toBeUndefined();
  });
});

describe('parseBucketInput', () => {
  test('takes the System, a long range, and the time asked for', () => {
    expect(parseBucketInput({ at: NOW, name: 'server-1', range: '30d' })).toEqual({
      at: NOW,
      name: 'server-1',
      range: '30d',
    });
    expect(parseBucketInput({ name: 'server-1', range: '1y' })).toEqual({
      at: undefined,
      name: 'server-1',
      range: '1y',
    });
  });

  test('refuses a range up to 7 d, which inspects a sample', () => {
    expect(() => parseBucketInput({ at: NOW, name: 'server-1', range: '7d' })).toThrow(
      'not 30d or 1y',
    );
  });
});
