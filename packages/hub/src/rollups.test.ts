import { expect, test } from 'bun:test';

import type { VitalsSample } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';
import type { SQL } from 'bun';

import { migrate, MIGRATIONS } from './migrations.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';

const MINUTE = 60_000;
const GIB = 1_073_741_824;

// The Vitals a test varies, on top of the fixture sample at time `t`.
type Vitals = {
  busy?: number;
  collectorCpu?: number;
  disks?: VitalsSample['disks'];
  load1?: number;
  rss?: number;
  total?: number;
  uptime?: number;
  used?: number;
};

const vitals = (t: number, v: Vitals = {}): VitalsSample => {
  const base = sample(t);
  return {
    collector: {
      cpuPercent: v.collectorCpu ?? base.collector.cpuPercent,
      rssBytes: v.rss ?? base.collector.rssBytes,
    },
    cpu: { busyPercent: v.busy ?? base.cpu.busyPercent },
    disks: v.disks ?? base.disks,
    load: [v.load1 ?? base.load[0], base.load[1], base.load[2]],
    memory: {
      totalBytes: v.total ?? base.memory.totalBytes,
      usedBytes: v.used ?? base.memory.usedBytes,
    },
    t,
    uptimeSeconds: v.uptime ?? base.uptimeSeconds,
  };
};

const disk = (mount: string, usedBytes: number, totalBytes: number) => ({
  mount,
  totalBytes,
  usedBytes,
});

const pushSamples = async (h: Awaited<ReturnType<typeof startHub>>, samples: VitalsSample[]) => {
  const response = await push(
    h.hub,
    { ...report('laptop-1', [NOW]), samples },
    { token: 'laptop-token' },
  );
  expect(response.status).toBe(200);
  return response.json();
};

type RollupRow = Record<string, Date | number | string>;

// Each rollup row with its numbers as numbers: PostgreSQL's bigint and numeric
// arrive as text.
const numbers = (rows: RollupRow[]) =>
  rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'string' && key !== 'system' && key !== 'mount' ? Number(value) : value,
      ]),
    ),
  );

const vitalsRollups = async (sql: SQL) =>
  numbers(await sql`SELECT * FROM vitals_rollups ORDER BY system, bucket`);

const diskRollups = async (sql: SQL) =>
  numbers(await sql`SELECT * FROM disk_rollups ORDER BY system, bucket, mount`);

test('samples in one 5-minute bucket roll up to their count, min, sum, and max', async () => {
  await using h = await startHub();

  await pushSamples(h, [
    vitals(NOW, {
      busy: 10,
      collectorCpu: 0.5,
      load1: 1.5,
      rss: 40_000_000,
      total: 32 * GIB,
      uptime: 1000,
      used: 8 * GIB,
    }),
    vitals(NOW + MINUTE, {
      busy: 40,
      collectorCpu: 1.5,
      load1: 0.5,
      rss: 50_000_000,
      total: 32 * GIB,
      uptime: 1060,
      used: 12 * GIB,
    }),
    vitals(NOW + 2 * MINUTE, {
      busy: 25,
      collectorCpu: 1,
      load1: 1,
      rss: 45_000_000,
      total: 16 * GIB,
      uptime: 30,
      used: 10 * GIB,
    }),
  ]);

  expect(await vitalsRollups(h.db.sql)).toEqual([
    {
      bucket: new Date(NOW),
      collector_cpu_max: 1.5,
      collector_cpu_sum: 3,
      collector_rss_max: 50_000_000,
      collector_rss_sum: 135_000_000,
      cpu_busy_max: 40,
      cpu_busy_min: 10,
      cpu_busy_sum: 75,
      load_1_max: 1.5,
      load_1_min: 0.5,
      load_1_sum: 3,
      memory_total_max: 32 * GIB,
      memory_used_max: 12 * GIB,
      memory_used_min: 8 * GIB,
      memory_used_sum: 30 * GIB,
      samples: 3,
      system: 'laptop-1',
      uptime_min: 30,
    },
  ]);
});

test('samples roll up into the UTC 5-minute bucket each falls in', async () => {
  await using h = await startHub();

  await pushSamples(h, [
    vitals(NOW - 1, { busy: 1 }),
    vitals(NOW, { busy: 2 }),
    vitals(NOW + 5 * MINUTE - 1, { busy: 3 }),
    vitals(NOW + 5 * MINUTE, { busy: 4 }),
  ]);

  const rows = await vitalsRollups(h.db.sql);
  expect(rows.map((r) => [r.bucket, r.samples, r.cpu_busy_sum])).toEqual([
    [new Date(NOW - 5 * MINUTE), 1, 1],
    [new Date(NOW), 2, 5],
    [new Date(NOW + 5 * MINUTE), 1, 4],
  ]);
});

test('a resent Report leaves the rollups as they were', async () => {
  await using h = await startHub();
  const samples = [vitals(NOW, { busy: 10 }), vitals(NOW + MINUTE, { busy: 20 })];
  await pushSamples(h, samples);
  const before = [await vitalsRollups(h.db.sql), await diskRollups(h.db.sql)];

  expect(await pushSamples(h, samples)).toEqual({ skipped: 2, stored: 0 });

  expect([await vitalsRollups(h.db.sql), await diskRollups(h.db.sql)]).toEqual(before);
});

test('a Report overlapping stored samples rolls up only the samples it adds', async () => {
  await using h = await startHub();
  await pushSamples(h, [vitals(NOW, { busy: 10 }), vitals(NOW + MINUTE, { busy: 20 })]);

  await pushSamples(h, [
    vitals(NOW + MINUTE, { busy: 90 }),
    vitals(NOW + 2 * MINUTE, { busy: 30 }),
  ]);

  const [row] = await vitalsRollups(h.db.sql);
  expect([row?.samples, row?.cpu_busy_sum, row?.cpu_busy_max]).toEqual([3, 60, 30]);
});

test('a late sample updates the bucket it belongs to, after later buckets', async () => {
  await using h = await startHub();
  await pushSamples(h, [
    vitals(NOW + MINUTE, { busy: 20, uptime: 500, used: 10 * GIB }),
    vitals(NOW + 10 * MINUTE, { busy: 50 }),
  ]);

  await pushSamples(h, [vitals(NOW + 30_000, { busy: 5, uptime: 20, used: 4 * GIB })]);

  const rows = await vitalsRollups(h.db.sql);
  expect(
    rows.map((r) => [
      r.bucket,
      r.samples,
      r.cpu_busy_min,
      r.cpu_busy_sum,
      r.cpu_busy_max,
      r.memory_used_min,
      r.uptime_min,
    ]),
  ).toEqual([
    [new Date(NOW), 2, 5, 25, 20, 4 * GIB, 20],
    [new Date(NOW + 10 * MINUTE), 1, 50, 50, 50, sample(NOW).memory.usedBytes, 86_400],
  ]);
});

test('disks roll up per mount to the most used and largest total in each bucket', async () => {
  await using h = await startHub();

  await pushSamples(h, [
    vitals(NOW, { disks: [disk('/', 30 * GIB, 100 * GIB), disk('/data', 5 * GIB, 500 * GIB)] }),
    vitals(NOW + MINUTE, {
      disks: [disk('/', 20 * GIB, 120 * GIB), disk('/data', 7 * GIB, 500 * GIB)],
    }),
  ]);
  await pushSamples(h, [vitals(NOW + 5 * MINUTE, { disks: [disk('/', 31 * GIB, 100 * GIB)] })]);

  expect(await diskRollups(h.db.sql)).toEqual([
    {
      bucket: new Date(NOW),
      mount: '/',
      system: 'laptop-1',
      total_max: 120 * GIB,
      used_max: 30 * GIB,
    },
    {
      bucket: new Date(NOW),
      mount: '/data',
      system: 'laptop-1',
      total_max: 500 * GIB,
      used_max: 7 * GIB,
    },
    {
      bucket: new Date(NOW + 5 * MINUTE),
      mount: '/',
      system: 'laptop-1',
      total_max: 100 * GIB,
      used_max: 31 * GIB,
    },
  ]);
});

test('the rollup migration rolls up the samples stored before it', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version < 3),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;
  const stored = (t: number, busy: number, used: number, disks: VitalsSample['disks']) => db.sql`
    INSERT INTO vitals_samples (
      system, t, cpu_busy_percent, memory_total_bytes, memory_used_bytes,
      load_1, load_5, load_15, uptime_seconds, disks, collector_cpu_percent, collector_rss_bytes
    ) VALUES (
      'laptop-1', ${new Date(t)}, ${busy}, ${32 * GIB}, ${used},
      1, 0.5, 0.25, ${t / 1000 - NOW / 1000 + 100}, ${JSON.stringify(disks)}::text::jsonb, 0.5, ${40_000_000}
    )
  `;
  await stored(NOW, 10, 8 * GIB, [disk('/', 30 * GIB, 100 * GIB)]);
  await stored(NOW + MINUTE, 30, 12 * GIB, [disk('/', 35 * GIB, 100 * GIB)]);
  await stored(NOW + 5 * MINUTE, 50, 4 * GIB, [disk('/', 36 * GIB, 100 * GIB)]);

  expect(await migrate(db.sql)).toEqual([3]);

  expect(await vitalsRollups(db.sql)).toEqual([
    {
      bucket: new Date(NOW),
      collector_cpu_max: 0.5,
      collector_cpu_sum: 1,
      collector_rss_max: 40_000_000,
      collector_rss_sum: 80_000_000,
      cpu_busy_max: 30,
      cpu_busy_min: 10,
      cpu_busy_sum: 40,
      load_1_max: 1,
      load_1_min: 1,
      load_1_sum: 2,
      memory_total_max: 32 * GIB,
      memory_used_max: 12 * GIB,
      memory_used_min: 8 * GIB,
      memory_used_sum: 20 * GIB,
      samples: 2,
      system: 'laptop-1',
      uptime_min: 100,
    },
    {
      bucket: new Date(NOW + 5 * MINUTE),
      collector_cpu_max: 0.5,
      collector_cpu_sum: 0.5,
      collector_rss_max: 40_000_000,
      collector_rss_sum: 40_000_000,
      cpu_busy_max: 50,
      cpu_busy_min: 50,
      cpu_busy_sum: 50,
      load_1_max: 1,
      load_1_min: 1,
      load_1_sum: 1,
      memory_total_max: 32 * GIB,
      memory_used_max: 4 * GIB,
      memory_used_min: 4 * GIB,
      memory_used_sum: 4 * GIB,
      samples: 1,
      system: 'laptop-1',
      uptime_min: 400,
    },
  ]);
  expect(await diskRollups(db.sql)).toEqual([
    {
      bucket: new Date(NOW),
      mount: '/',
      system: 'laptop-1',
      total_max: 100 * GIB,
      used_max: 35 * GIB,
    },
    {
      bucket: new Date(NOW + 5 * MINUTE),
      mount: '/',
      system: 'laptop-1',
      total_max: 100 * GIB,
      used_max: 36 * GIB,
    },
  ]);
});
