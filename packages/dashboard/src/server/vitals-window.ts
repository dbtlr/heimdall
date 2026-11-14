import type { ConditionLimitSet } from '@heimdall/schema';
import type { SQL } from 'bun';

import { vitalsBuckets } from '../lib/vitals-window.ts';
import type { VitalsPoint, VitalsWindow } from './vitals-window-types.ts';

type Reading = { bucket: Date; cpu: number | null; load: number | null; memory: number | null };

// The platform the System's Collector last reported, if any.
export const readPlatform = async (sql: SQL, system: string): Promise<string | undefined> => {
  const [row]: { collector_platform: string | null }[] = await sql`
    SELECT collector_platform FROM systems WHERE name = ${system}
  `;
  return row?.collector_platform ?? undefined;
};

// The start of the `widthMs` bucket holding `t`. Buckets align to the epoch,
// as the Hub's 5-minute rollups do, so a wider bucket holds whole rollups.
const bucketAt = (t: number, widthMs: number) => Math.floor(t / widthMs) * widthMs;

type Read = { from: number; system: string; to: number; widthMs: number };

// The raw samples of the window averaged in `widthMs` buckets, from the bucket
// holding its start through the one holding its end.
const readSamples = (sql: SQL, { from, system, to, widthMs }: Read): Promise<Reading[]> => sql`
  SELECT date_bin(make_interval(secs => ${widthMs / 1000}), t,
                  timestamptz '1970-01-01 00:00:00+00') AS bucket,
         avg(cpu_busy_percent)::float8 AS cpu,
         avg(memory_used_bytes::float8 / NULLIF(memory_total_bytes, 0) * 100)::float8 AS memory,
         avg(load_1)::float8 AS load
  FROM vitals_samples
  WHERE system = ${system} AND t >= ${new Date(bucketAt(from, widthMs))} AND t <= ${new Date(to)}
  GROUP BY 1
  ORDER BY 1
`;

// The 5-minute rollups of the window averaged in `widthMs` buckets, from the
// one holding its start through the one holding its end.
const readRollups = (sql: SQL, { from, system, to, widthMs }: Read): Promise<Reading[]> => sql`
  SELECT date_bin(make_interval(secs => ${widthMs / 1000}), bucket,
                  timestamptz '1970-01-01 00:00:00+00') AS bucket,
         (sum(cpu_busy_sum) / NULLIF(sum(samples), 0))::float8 AS cpu,
         (sum(memory_used_sum) / NULLIF(sum(samples), 0) / NULLIF(max(memory_total_max), 0) * 100)::float8 AS memory,
         (sum(load_1_sum) / NULLIF(sum(samples), 0))::float8 AS load
  FROM vitals_rollups
  WHERE system = ${system} AND bucket >= ${new Date(bucketAt(from, widthMs))} AND bucket <= ${new Date(to)}
  GROUP BY 1
  ORDER BY 1
`;

// The System's CPU, memory, and load from `from` to `to`, averaged in buckets
// wide enough that the window draws a bounded number of points, from raw
// samples while the window is short and within their retention, else from the
// 5-minute rollups. `to` is held to `now`. The caller passes the limits the Hub
// judges the System by and its platform, which it reads for itself. Read-only.
export const readVitalsWindow = async (
  sql: SQL,
  {
    from,
    limits,
    now,
    platform,
    system,
    to,
  }: {
    from: number;
    limits: ConditionLimitSet | undefined;
    now: number;
    platform: string | undefined;
    system: string;
    to: number;
  },
): Promise<VitalsWindow> => {
  const end = Math.min(to, now);
  const { bucketMs, source } = vitalsBuckets({ from, to: end }, now);
  const rows = await (source === 'samples' ? readSamples : readRollups)(sql, {
    from,
    system,
    to: end,
    widthMs: bucketMs,
  });
  const points: VitalsPoint[] = rows.map((row) => ({
    cpu: row.cpu,
    load: row.load,
    memory: row.memory,
    // The bucket's middle, held inside the window.
    t: Math.min(end, Math.max(from, row.bucket.getTime() + bucketMs / 2)),
  }));
  return {
    bucketMs,
    from,
    limits: {
      cpuPercent: limits?.cpu.percent,
      memoryPercent: platform === 'darwin' ? undefined : limits?.memory.percent,
    },
    points,
    source,
    to: end,
  };
};
