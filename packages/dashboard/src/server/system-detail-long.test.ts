// The System page over 30 d and 1 y: Vitals re-binned from the 5-minute
// rollups, Harness process CPU from their rollups, cost per bucket, reboots,
// and the bucket the inspector reads.

import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { localDays } from '../lib/home-agents.ts';
import { readCostChart } from './agents-costs.ts';
import { agentsPeriod, readSessionDetails, sessionsPeriod } from './agents-overview.ts';
import { readDayCosts } from './day-costs.ts';
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

// The message `read` rejects with, or undefined when it resolves.
const failure = async (read: Promise<unknown>): Promise<string | undefined> => {
  try {
    await read;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
};

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

const detail = async (
  h: Hub,
  range: '30d' | '1y' | '7d',
  { now = NOW, timeZone = 'UTC' }: { now?: number; timeZone?: string } = {},
) => {
  const found = await readSystemDetail(h.db.sql, { name: 'server-1', now, range, timeZone });
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

    expect(long?.dayEdges[0]).toBe(TODAY - 30 * DAY);
    expect(long?.dayEdges.at(-1)).toBe(TODAY + DAY);
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

// Seconds from NOW to `t`, as the timeline fixtures take times.
const offset = (t: number) => (t - NOW) / 1000;

// What Agents' cost chart puts on `system` per bar over its 30 days, by the
// bar's start, read over the period the Agents page reads.
const agentsCosts = async (h: Hub, timeZone: string, system = 'server-1', now = NOW) => {
  const period = sessionsPeriod(agentsPeriod({ now, range: '30d', timeZone }), now);
  const chart = await readCostChart(h.db.sql, {
    now,
    period,
    range: '30d',
    timeZone,
    whole: readSessionDetails(h.db.sql, period).then(({ whole }) => whole),
  });
  const byStart = new Map<number, number>();
  for (const cell of chart.cells.filter((found) => found.system === system)) {
    const start = chart.buckets[cell.bucket]?.start ?? 0;
    byStart.set(start, (byStart.get(start) ?? 0) + cell.pricedCostUsd);
  }
  return byStart;
};

const barTotals = (costs: readonly { costUsd: number; t: number }[]) => {
  const totals = new Map<number, number>();
  for (const { costUsd, t } of costs) {
    totals.set(t, (totals.get(t) ?? 0) + costUsd);
  }
  return totals;
};

describe("the long ranges in the viewer's zone", () => {
  // 20 Sep 2026 in Berlin, CEST, starts at 22:00 UTC the day before.
  const BERLIN_20 = Date.UTC(2026, 8, 19, 22);
  const BERLIN_19 = BERLIN_20 - DAY;

  const storeBerlinSessions = async (h: Hub) => {
    await price(h);
    // 00:30 and 00:40 on the 20th in Berlin, 22:30 UTC on the 19th: $10.
    await addSession(h.db.sql, {
      id: 's1',
      model: 'priced-model',
      requests: [offset(BERLIN_20 + 30 * MINUTE), offset(BERLIN_20 + 40 * MINUTE)],
      system: 'server-1',
    });
    // Across Berlin's midnight: $5 on each day.
    await addSession(h.db.sql, {
      harness: 'codex',
      id: 's2',
      model: 'priced-model',
      requests: [offset(BERLIN_20 - 10 * MINUTE), offset(BERLIN_20 + 10 * MINUTE)],
      system: 'server-1',
    });
    // Noon on the 20th in Berlin: $5.
    await addSession(h.db.sql, {
      id: 's3',
      model: 'priced-model',
      requests: [offset(BERLIN_20 + 12 * HOUR)],
      system: 'server-1',
    });
    // Another System's Session the next day stays off server-1's bars.
    await addSession(h.db.sql, {
      id: 's4',
      model: 'priced-model',
      requests: [offset(BERLIN_20 + DAY + HOUR)],
      system: 'laptop-1',
    });
  };

  test('a year in Berlin bins Vitals and cost by local day, as Agents and Home count that day', async () => {
    await using h = await startHub();
    await hear(h);
    await hear(h, 'laptop-1');
    await storeRollups(h, [
      flat(BERLIN_20 - BUCKET),
      flat(BERLIN_20),
      flat(BERLIN_20 + DAY - BUCKET),
    ]);
    await storeBerlinSessions(h);

    const found = await detail(h, '1y', { timeZone: 'Europe/Berlin' });

    // 6 Oct 2025, the range's first day, starts at 22:00 UTC on the 5th in Berlin.
    expect(found.edges?.[0]).toBe(Date.UTC(2025, 9, 5, 22));
    expect(found.edges?.at(-1)).toBe(Date.UTC(2026, 9, 6, 22));
    expect(found.cpu.map(({ t }) => t)).toEqual([BERLIN_19, BERLIN_20]);
    expect(found.memory.map(({ t }) => t)).toEqual([BERLIN_19, BERLIN_20]);
    const bars = barTotals(found.long?.costs ?? []);
    expect(bars).toEqual(
      new Map([
        [BERLIN_19, 5],
        [BERLIN_20, 20],
      ]),
    );
    const agents = await agentsCosts(h, 'Europe/Berlin');
    expect(agents.get(BERLIN_19)).toBe(bars.get(BERLIN_19));
    expect(agents.get(BERLIN_20)).toBe(bars.get(BERLIN_20));
    // Home's days: the 20th is 16 days before the 6th.
    const [home] = await readDayCosts(h.db.sql, localDays(NOW, 'Europe/Berlin', 17));
    expect(home?.pricedCostUsd).toBe(bars.get(BERLIN_20));
    expect(found.long?.dayEdges).toEqual(found.edges);
    // Weeks from Monday in Berlin: 6 Oct 2025 was a Monday.
    expect(found.long?.changeEdges[1]).toBe(Date.UTC(2025, 9, 12, 22));
  });

  test('30 days in Berlin bins by 3 hours of the local clock from local midnight, and the cost by local day', async () => {
    await using h = await startHub();
    await hear(h);
    await storeRollups(h, [
      flat(BERLIN_20 + 10 * MINUTE),
      flat(BERLIN_20 + 2 * HOUR + 50 * MINUTE),
      flat(BERLIN_20 + 3 * HOUR),
    ]);
    await storeBerlinSessions(h);

    const found = await detail(h, '30d', { timeZone: 'Europe/Berlin' });

    expect(found.cpu.map(({ t }) => t)).toEqual([BERLIN_20, BERLIN_20 + 3 * HOUR]);
    expect(found.edges).toContain(BERLIN_20);
    expect(barTotals(found.long?.costs ?? []).get(BERLIN_20)).toBe(20);
    expect(found.long?.dayEdges).toContain(BERLIN_20);
    expect(found.long?.dayEdges).not.toContain(BERLIN_20 + 3 * HOUR);
  });

  test("the inspector's bucket and day are the chart's, in Berlin", async () => {
    await using h = await startHub();
    await hear(h);
    await storeBerlinSessions(h);

    const day = await readBucket(h.db.sql, {
      at: BERLIN_20 + 30 * MINUTE,
      name: 'server-1',
      now: NOW,
      range: '1y',
      timeZone: 'Europe/Berlin',
    });
    const bucket = await readBucket(h.db.sql, {
      at: BERLIN_20 + 30 * MINUTE,
      name: 'server-1',
      now: NOW,
      range: '30d',
      timeZone: 'Europe/Berlin',
    });

    expect(day).toMatchObject({
      costUsd: 20,
      day: undefined,
      end: BERLIN_20 + DAY,
      sessions: 3,
      t: BERLIN_20,
    });
    // The 3-hour bucket holds s1 and half of s2; its day holds s3 as well.
    expect(bucket).toMatchObject({
      costUsd: 15,
      day: { costUsd: 20, end: BERLIN_20 + DAY, start: BERLIN_20, unpricedRequests: 0 },
      end: BERLIN_20 + 3 * HOUR,
      sessions: 2,
      t: BERLIN_20,
    });
  });

  test("a request stamped a minute ahead, past the last day's end, counts in the last bar, as in Agents' and the inspector's", async () => {
    await using h = await startHub();
    await hear(h);
    await price(h);
    // Read 30 s before midnight UTC, a request a minute later falls in the next
    // day, within the clock tolerance of the read.
    const now = TODAY + DAY - 30 * SECOND;
    await addSession(h.db.sql, {
      id: 's1',
      model: 'priced-model',
      requests: [offset(now + MINUTE)],
      system: 'server-1',
    });

    const found = await detail(h, '1y', { now });

    expect(barTotals(found.long?.costs ?? [])).toEqual(new Map([[TODAY, 5]]));
    expect(found.long?.sessions).toBe(1);
    expect((await agentsCosts(h, 'UTC', 'server-1', now)).get(TODAY)).toBe(5);
    const day = await readBucket(h.db.sql, {
      at: now,
      name: 'server-1',
      now,
      range: '1y',
      timeZone: 'UTC',
    });
    expect(day).toMatchObject({ costUsd: 5, t: TODAY });
  });

  test('a year in Los Angeles gives the day the clocks went back its 25 hours, and a Session at 00:30 the day it began', async () => {
    await using h = await startHub();
    await hear(h);
    await price(h);
    // 2 Nov 2025 in Los Angeles: midnight PDT is 07:00 UTC, the next midnight PST 08:00 UTC.
    const fallBack = Date.UTC(2025, 10, 2, 7);
    const next = fallBack + 25 * HOUR;
    await storeRollups(h, [flat(fallBack), flat(next - BUCKET), flat(next)]);
    await addSession(h.db.sql, {
      id: 's1',
      model: 'priced-model',
      requests: [offset(next + 30 * MINUTE)],
      system: 'server-1',
    });

    const found = await detail(h, '1y', { timeZone: 'America/Los_Angeles' });

    expect(found.cpu.map(({ t }) => t)).toEqual([fallBack, next]);
    expect(found.long?.costs.map(({ t }) => t)).toEqual([next]);
    const days = localDays(NOW, 'America/Los_Angeles', 400);
    const index = days.findIndex(({ start }) => start === next);
    expect(index).toBeGreaterThan(0);
    const home = await readDayCosts(h.db.sql, days);
    expect(home[index]?.pricedCostUsd).toBe(found.long?.costs[0]?.costUsd);
    expect(found.gaps).not.toContainEqual(expect.objectContaining({ from: fallBack }));
  });
});

describe('reads that agree on the bucket', () => {
  test('averages over every sample, however unevenly the rollups hold them', async () => {
    await using h = await startHub();
    await hear(h);
    const day = TODAY - 20 * DAY;
    await storeRollups(h, [
      { cpu: [90, 90, 90], load: [9, 9, 9], memory: [30, 30, 30], samples: 1, t: day },
      {
        cpu: [10, 59 * 10, 10],
        load: [1, 59, 1],
        memory: [6, 59 * 6, 6],
        samples: 59,
        t: day + HOUR,
      },
    ]);

    const found = await detail(h, '1y');
    const bucket = await readBucket(h.db.sql, { at: day, name: 'server-1', now: NOW, range: '1y' });

    // (90 + 590) / 60, not the mean of 90 and 10.
    expect(found.cpu[0]?.average).toBeCloseTo(680 / 60, 6);
    expect(found.memory[0]?.usedBytes).toBeCloseTo((384 / 60) * GIB, 0);
    expect(found.load[0]?.value).toBeCloseTo(68 / 60, 6);
    expect(bucket?.cpu?.average).toBeCloseTo(680 / 60, 6);
    expect(bucket?.memory?.average).toBeCloseTo((384 / 60) * GIB, 0);
    expect(bucket?.load1?.average).toBeCloseTo(68 / 60, 6);
  });

  test("divides the newest bucket's process CPU by the time it has covered", async () => {
    await using h = await startHub();
    await hear(h);
    // One core from NOW, an hour into the 3-hour bucket from NOW.
    await addProcess(h.db.sql, {
      cpuCores: 1,
      pid: 10,
      readings: 'rollups',
      seenTo: 3600,
      start: 0,
      system: 'server-1',
    });

    const { processes } = await detail(h, '30d', { now: NOW + HOUR });

    expect(processes[0]?.points.at(-1)?.t).toBe(NOW);
    expect(processes[0]?.points.at(-1)?.cores).toBeCloseTo(1, 2);
  });

  test('a reboot, a Session, and a process in the first bucket before the range starts show on the chart and in the inspector', async () => {
    await using h = await startHub();
    await hear(h);
    await price(h);
    // NOW is noon, so the year's first day starts 12 hours before its start.
    const first = TODAY - 365 * DAY;
    const boot = first + 3 * HOUR;
    await storeRollups(h, [flat(boot - BUCKET, 500_000), flat(boot, 100)]);
    await addSession(h.db.sql, {
      id: 's1',
      model: 'priced-model',
      requests: [offset(first + 6 * HOUR)],
      system: 'server-1',
    });
    await addProcess(h.db.sql, {
      cpuCores: 1,
      end: offset(first + 7 * HOUR),
      pid: 10,
      readings: 'rollups',
      start: offset(first + 6 * HOUR),
      system: 'server-1',
    });

    const found = await detail(h, '1y');
    const bucket = await readBucket(h.db.sql, {
      at: NOW - 365 * DAY,
      name: 'server-1',
      now: NOW,
      range: '1y',
    });

    expect(found.edges?.[0]).toBe(first);
    expect(found.long?.reboots).toEqual([boot]);
    expect(found.long?.costs).toEqual([
      { costUsd: 5, harness: 'claude-code', t: first, unpriced: 0 },
    ]);
    expect(found.long?.sessions).toBe(1);
    expect(found.processes.map(({ pid }) => pid)).toEqual([10]);
    expect(bucket).toMatchObject({ costUsd: 5, rebootedAt: boot, sessions: 1, t: first });
    expect(bucket?.processes.map(({ pid }) => pid)).toEqual([10]);
  });

  test('shows the eight busiest Harness processes over the range by name, and folds the rest into one series', async () => {
    await using h = await startHub();
    await hear(h);
    const start = offset(NOW - 2 * DAY);
    for (let pid = 1; pid <= 10; pid += 1) {
      // oxlint-disable-next-line no-await-in-loop -- ten fixture processes.
      await addProcess(h.db.sql, {
        cpuCores: pid / 10,
        end: start + 3 * 3600 - 15,
        pid,
        readings: 'rollups',
        start,
        system: 'server-1',
      });
    }

    const { processes } = await detail(h, '30d');
    const bucket = await readBucket(h.db.sql, {
      at: NOW - 2 * DAY,
      name: 'server-1',
      now: NOW,
      range: '30d',
    });

    expect(processes.map(({ pid }) => pid)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 0]);
    const other = processes.at(-1);
    expect(other).toMatchObject({ harness: 'other', processId: 0, project: '2 other processes' });
    expect(other?.points[0]?.cores).toBeCloseTo(0.3, 2);
    // The inspector still names every process in the bucket.
    expect(bucket?.processes).toHaveLength(10);
  });
});

describe('reboots', () => {
  test('any drop in uptime from the rollup before is a reboot, however long the Collector took to start', async () => {
    await using h = await startHub();
    await hear(h);
    const boot = NOW - 40 * DAY;
    await storeRollups(h, [
      flat(boot - BUCKET, 500_000),
      flat(boot, 900),
      flat(boot + BUCKET, 1200),
    ]);

    const { long } = await detail(h, '1y');

    expect(long?.reboots).toEqual([boot]);
  });

  test("a laptop's sleep, where uptime keeps counting, is no reboot", async () => {
    await using h = await startHub();
    await hear(h);
    const sleep = NOW - 40 * DAY;
    await storeRollups(h, [flat(sleep, 10_000), flat(sleep + 8 * HOUR, 10_000 + 8 * 3600)]);

    const { long } = await detail(h, '1y');

    expect(long?.reboots).toEqual([]);
  });

  test("the System's first rollup is a reboot only when its uptime is under 5 minutes", async () => {
    await using h = await startHub();
    await hear(h);
    await storeRollups(h, [flat(NOW - 40 * DAY, 120)]);
    await using fresh = await startHub();
    await hear(fresh);
    await storeRollups(fresh, [flat(NOW - 40 * DAY, 5000)]);

    expect((await detail(h, '1y')).long?.reboots).toEqual([NOW - 40 * DAY]);
    expect((await detail(fresh, '1y')).long?.reboots).toEqual([]);
  });
});

const versions = async (h: Hub, at: number) => {
  await h.db.sql`DELETE FROM service_versions`;
  await h.db.sql`
    INSERT INTO service_versions (system, service, version, upstream, first_seen_at) VALUES
      ('server-1', 'web', '1.0.0', null, ${new Date(at - 40 * DAY)}),
      ('server-1', 'web', '1.0.1', null, ${new Date(at)})
  `;
};

describe('the first bucket, which starts before the range does', () => {
  for (const timeZone of ['UTC', 'Europe/Berlin']) {
    test(`counts a version change 11 hours before the 1 y range starts, inside its first week, in ${timeZone}`, async () => {
      await using h = await startHub();
      await hear(h);
      const from = NOW - 365 * DAY;
      await versions(h, from - 11 * HOUR);

      const found = await detail(h, '1y', { timeZone });

      expect(found.changes.map(({ at, kind }) => [kind, at])).toEqual([
        ['version', from - 11 * HOUR],
      ]);
      expect(found.long?.changeEdges[0]).toBeLessThanOrEqual(from - 11 * HOUR);
    });
  }

  test('draws a Condition cleared in the first bucket before the range starts, and the inspector lists it', async () => {
    await using h = await startHub();
    await hear(h);
    const first = TODAY - 365 * DAY;
    await addCondition(h.db.sql, {
      clearedAt: (first + 3 * HOUR - NOW) / 1000,
      kind: 'high_cpu',
      raisedAt: (first + HOUR - NOW) / 1000,
      system: 'server-1',
    });

    const found = await detail(h, '1y');
    const bucket = await readBucket(h.db.sql, {
      at: first + HOUR,
      name: 'server-1',
      now: NOW,
      range: '1y',
    });

    expect(found.edges?.[0]).toBe(first);
    expect(found.conditions.map(({ kind }) => kind)).toEqual(['high_cpu']);
    expect(bucket?.conditions.map(({ kind }) => kind)).toEqual(['high_cpu']);
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

  test('leaves out the Conditions the open Conditions leave to Maintenance and Services, as the lane does', async () => {
    await using h = await startHub();
    await hear(h);
    const daySeconds = offset(TODAY - 20 * DAY);
    await addCondition(h.db.sql, {
      kind: 'pending_update',
      level: 'note',
      raisedAt: daySeconds + 3600,
      subject: 'apt',
      system: 'server-1',
    });
    await addCondition(h.db.sql, {
      kind: 'service_restarted',
      level: 'warning',
      raisedAt: daySeconds + 3600,
      subject: 'web',
      system: 'server-1',
    });
    // Once it rose to warning, it is history the lane keeps.
    await addCondition(h.db.sql, {
      clearedAt: daySeconds + 4 * 3600,
      kind: 'reboot_required',
      level: 'note',
      raisedAt: daySeconds + 3600,
      system: 'server-1',
      transitions: [{ at: daySeconds + 2 * 3600, level: 'warning' }],
    });

    const found = await readBucket(h.db.sql, {
      at: TODAY - 20 * DAY,
      name: 'server-1',
      now: NOW,
      range: '1y',
    });

    expect(found?.conditions.map(({ kind }) => kind)).toEqual(['reboot_required']);
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

  test('inspects the bucket the page drew, not the one a later clock makes first', async () => {
    await using h = await startHub();
    await hear(h);
    const drawn = await detail(h, '1y');
    const [start, end] = [drawn.edges?.[0] ?? 0, drawn.edges?.[1] ?? 0];
    // The page was left open past midnight: the server's day edges moved on.
    const later = NOW + 13 * HOUR;

    const pinned = await readBucket(h.db.sql, {
      at: undefined,
      name: 'server-1',
      now: later,
      range: '1y',
      span: { end, start },
    });
    const recomputed = await readBucket(h.db.sql, {
      at: start + HOUR,
      name: 'server-1',
      now: later,
      range: '1y',
    });

    expect(pinned).toMatchObject({ end, t: start });
    expect(recomputed?.t).not.toBe(start);
  });

  test('refuses a span that is empty, too wide for the range, or in the future', async () => {
    await using h = await startHub();
    await hear(h);
    const ask = (range: '1y' | '30d', start: number, end: number) =>
      readBucket(h.db.sql, {
        at: undefined,
        name: 'server-1',
        now: NOW,
        range,
        span: { end, start },
      });
    const t = TODAY - 10 * DAY;

    expect(await failure(ask('1y', t, t))).toContain('span');
    expect(await failure(ask('1y', t, t + 27 * HOUR))).toContain('span');
    expect(await failure(ask('30d', t, t + 6 * HOUR))).toContain('span');
    expect(await failure(ask('1y', NOW + HOUR, NOW + 2 * HOUR))).toContain('span');
    expect(await ask('1y', t, t + 25 * HOUR)).toMatchObject({ t });
    expect(await ask('30d', t, t + 3 * HOUR)).toMatchObject({ t });
  });

  // Antarctica/Troll moves its clock two hours, so its days run to 26 hours
  // and its 3-hour buckets to 5.
  test('accepts the 26-hour day and 5-hour bucket of a two-hour clock change', async () => {
    await using h = await startHub();
    await hear(h);
    const t = TODAY - 10 * DAY;
    const ask = (range: '1y' | '30d', end: number) =>
      readBucket(h.db.sql, {
        at: undefined,
        name: 'server-1',
        now: NOW,
        range,
        span: { end, start: t },
        timeZone: 'Antarctica/Troll',
      });

    expect(await ask('1y', t + 26 * HOUR)).toMatchObject({ t });
    expect(await ask('30d', t + 5 * HOUR)).toMatchObject({ t });
    expect(await failure(ask('1y', t + 27 * HOUR))).toContain('span');
    expect(await failure(ask('30d', t + 6 * HOUR))).toContain('span');
  });

  test('names the level a Condition held in the bucket, as the lane draws it', async () => {
    await using h = await startHub();
    await hear(h);
    const day = TODAY - 10 * DAY;
    const daySeconds = (day - NOW) / 1000;
    const dayAfter = daySeconds + DAY / 1000;
    // Warning all day, alert only after it.
    await addCondition(h.db.sql, {
      kind: 'high_cpu',
      level: 'warning',
      raisedAt: daySeconds + 3600,
      system: 'server-1',
      transitions: [{ at: dayAfter + 3600, level: 'alert' }],
    });
    // Warning, then alert within the day: the highest it held.
    await addCondition(h.db.sql, {
      kind: 'high_memory',
      level: 'warning',
      raisedAt: daySeconds + 3600,
      system: 'server-1',
      transitions: [{ at: daySeconds + 7200, level: 'alert' }],
    });
    // Alert before the day, eased to warning for it.
    await addCondition(h.db.sql, {
      kind: 'low_disk',
      level: 'alert',
      raisedAt: daySeconds - 7200,
      subject: '/data',
      system: 'server-1',
      transitions: [{ at: daySeconds - 3600, level: 'warning' }],
    });

    const found = await readBucket(h.db.sql, {
      at: day + 15 * HOUR,
      name: 'server-1',
      now: NOW,
      range: '1y',
    });

    expect(
      Object.fromEntries(found?.conditions.map(({ kind, level }) => [kind, level]) ?? []),
    ).toEqual({ high_cpu: 'warning', high_memory: 'alert', low_disk: 'warning' });
  });

  test('answers nothing for a name that is no System', async () => {
    await using h = await startHub();

    expect(
      await readBucket(h.db.sql, { at: NOW, name: 'nas-1', now: NOW, range: '1y' }),
    ).toBeUndefined();
  });
});

describe('parseBucketInput', () => {
  test("takes the System, a long range, the time asked for, and the viewer's zone", () => {
    expect(
      parseBucketInput({ at: NOW, name: 'server-1', range: '30d', timeZone: 'Europe/Berlin' }),
    ).toEqual({ at: NOW, name: 'server-1', range: '30d', timeZone: 'Europe/Berlin' });
    expect(
      parseBucketInput({ name: 'server-1', range: '30d', timeZone: 'Not/A_Zone' }).timeZone,
    ).toBeUndefined();
    expect(parseBucketInput({ name: 'server-1', range: '1y' })).toEqual({
      at: undefined,
      name: 'server-1',
      range: '1y',
      timeZone: undefined,
    });
  });

  test('refuses a range up to 7 d, which inspects a sample', () => {
    expect(() => parseBucketInput({ at: NOW, name: 'server-1', range: '7d' })).toThrow(
      'not 30d or 1y',
    );
  });
});
