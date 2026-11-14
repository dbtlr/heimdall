import type { ConditionLimitSet } from '@heimdall/schema';
import type { SQL } from 'bun';

import { bucketFor } from '../lib/bucket-width.ts';
import type { AxisLane, AxisStretch } from './activity-types.ts';
import { toBucket } from './fleet-overview.ts';
import type { BucketRow } from './fleet-overview.ts';

// The axis draws about this many CPU buckets across, whatever the range, so
// the read returns what the axis shows and not what the range holds.
const AXIS_BUCKETS = 144;

// The width of an axis CPU bucket over a range of `rangeMs`: 10 minutes over
// 24 hours, 2 hours over 7 days, and 6 hours over 30. Each width divides a
// day, so a bucket holds whole 5-minute rollups.
export const axisBucketMs = (rangeMs: number): number => bucketFor(rangeMs, AXIS_BUCKETS);

type StretchRow = { ended_at: Date; harness: string; started_at: Date; system: string };

// The stretches of Sessions that overlap `from` to `to`, on every System or on
// `only`. The index on a stretch's end finds them, so the read costs the
// stretches of the window. A System with Sessions needs no `systems` row.
export const readAxisStretches = async (
  sql: SQL,
  { from, only, to }: { from: Date; only: string | null; to: Date },
): Promise<Map<string, AxisStretch[]>> => {
  const rows: StretchRow[] = await sql`
    SELECT system, harness, started_at, ended_at
    FROM insight.session_stretches
    WHERE ended_at >= ${from} AND started_at <= ${to}
      AND (${only}::text IS NULL OR system = ${only})
    ORDER BY system, started_at
  `;
  const byName = new Map<string, AxisStretch[]>();
  for (const row of rows) {
    const own = byName.get(row.system) ?? [];
    own.push({
      endedAt: row.ended_at.getTime(),
      harness: row.harness,
      startedAt: row.started_at.getTime(),
    });
    byName.set(row.system, own);
  }
  return byName;
};

// The CPU rollups of `systems` from the bucket holding `from` to `to`,
// averaged in `widthMs` buckets, in one statement however many Systems.
export const readAxisCpu = (
  sql: SQL,
  {
    from,
    systems,
    to,
    widthMs,
  }: { from: number; systems: readonly string[]; to: number; widthMs: number },
): Promise<BucketRow[]> => sql`
  SELECT system,
         date_bin(make_interval(secs => ${widthMs / 1000}), bucket,
                  timestamptz '1970-01-01 00:00:00+00') AS bucket,
         sum(samples)::int AS samples, min(cpu_busy_min) AS cpu_busy_min,
         sum(cpu_busy_sum) AS cpu_busy_sum, max(cpu_busy_max) AS cpu_busy_max
  FROM vitals_rollups
  WHERE system IN ${sql(systems)}
    AND bucket >= ${new Date(Math.floor(from / widthMs) * widthMs)} AND bucket < ${new Date(to)}
  GROUP BY 1, 2
  ORDER BY 1, 2
`;

// The CPU limit the Hub judges each System by: its own, else the fleet's.
// A System without either has none.
const readCpuLimits = async (sql: SQL): Promise<(system: string) => number | undefined> => {
  const rows: { limits: ConditionLimitSet; system: string }[] = await sql`
    SELECT system, limits FROM condition_limits
  `;
  const percents = new Map(rows.map((row) => [row.system, row.limits.cpu.percent]));
  return (system) => percents.get(system) ?? percents.get('');
};

// A lane for each of `systems`: its CPU, the limit it is judged by, and the
// stretches of its Sessions.
export const readAxisLanes = async (
  sql: SQL,
  {
    from,
    stretches,
    systems,
    to,
    widthMs,
  }: {
    from: number;
    stretches: ReadonlyMap<string, AxisStretch[]>;
    systems: readonly string[];
    to: number;
    widthMs: number;
  },
): Promise<AxisLane[]> => {
  const [rows, limitOf] = await Promise.all([
    systems.length === 0 ? Promise.resolve([]) : readAxisCpu(sql, { from, systems, to, widthMs }),
    readCpuLimits(sql),
  ]);
  const bucketsOf = Map.groupBy(rows, (row) => row.system);
  return systems.map((system) => ({
    buckets: (bucketsOf.get(system) ?? []).map(toBucket),
    cpuLimit: limitOf(system),
    stretches: stretches.get(system) ?? [],
    system,
  }));
};
