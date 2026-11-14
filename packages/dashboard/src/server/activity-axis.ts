import type { SQL } from 'bun';

import { joinStretches, stretchGapMs } from '../lib/axis-stretches.ts';
import { bucketFor } from '../lib/bucket-width.ts';
import { ACTIVITY_RANGE_MS } from './activity-types.ts';
import type { ActivityPage, ActivityRange, AxisStretch } from './activity-types.ts';
import { readActivitySnapshot } from './activity.ts';
import { readConditionLimitsOf } from './condition-limits.ts';
import { readCpuBuckets, toBucket } from './fleet-overview.ts';

// The axis draws about this many CPU buckets across, whatever the range, so
// the read returns what the axis shows and not what the range holds.
const AXIS_BUCKETS = 144;

// The width of an axis CPU bucket over a range of `rangeMs`: 10 minutes over
// 24 hours, 2 hours over 7 days, and 6 hours over 30. Each width divides a
// day, so a bucket holds whole 5-minute rollups.
const axisBucketMs = (rangeMs: number): number => bucketFor(rangeMs, AXIS_BUCKETS);

type StretchRow = { ended_at: Date; harness: string; started_at: Date; system: string };

// The stretches of Sessions that overlap `from` to `to` on every System, by
// System, those of one Harness closer than the axis tells apart joined (see
// joinStretches), so what the page carries follows the axis's width and not
// the number of Sessions. The index on a stretch's end finds them, so the read
// costs the stretches of the window. A System with Sessions needs no
// `systems` row.
const readAxisStretches = async (
  sql: SQL,
  { from, to }: { from: number; to: number },
): Promise<Map<string, AxisStretch[]>> => {
  const rows: StretchRow[] = await sql`
    SELECT system, harness, started_at, ended_at
    FROM insight.session_stretches
    WHERE ended_at >= ${new Date(from)} AND started_at <= ${new Date(to)}
    ORDER BY system, started_at
  `;
  const gapMs = stretchGapMs(to - from);
  const bySystem = Map.groupBy(rows, (row) => row.system);
  return new Map(
    [...bySystem].map(([system, own]) => [
      system,
      joinStretches(
        own.map((row) => ({
          endedAt: row.ended_at.getTime(),
          harness: row.harness,
          startedAt: row.started_at.getTime(),
        })),
        gapMs,
      ),
    ]),
  );
};

const byName = (a: string, b: string) => a.localeCompare(b);

// The Activity page: every change in the range that ends at `now`, and a lane
// on the shared axis for each System the changes, the Sessions, or the Hub's
// pairings name, paired Systems first, then the unpaired ones, each by name.
// A lane holds the System's CPU in axis buckets, the CPU limit the Hub judges
// it by (its own, else the fleet's), and its Session stretches. A System's
// Activity tab reads readActivitySnapshot alone, as it draws no axis.
export const readActivityPage = (
  sql: SQL,
  { now, range }: { now: number; range: ActivityRange },
): Promise<ActivityPage> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const from = now - ACTIVITY_RANGE_MS[range];
    const [activity, stretches] = await Promise.all([
      readActivitySnapshot(tx, { now, range }),
      readAxisStretches(tx, { from, to: now }),
    ]);
    const unpairedOnes = new Set(activity.unpaired);
    const paired = activity.systems.filter((system) => !unpairedOnes.has(system));
    for (const system of stretches.keys()) {
      if (!activity.systems.includes(system)) {
        unpairedOnes.add(system);
      }
    }
    const unpaired = [...unpairedOnes].toSorted(byName);
    const names = [...paired.toSorted(byName), ...unpaired];
    const bucketMs = axisBucketMs(now - from);
    const [rows, limitsOf] = await Promise.all([
      names.length === 0
        ? Promise.resolve([])
        : readCpuBuckets(tx, { from, names, to: now, widthMs: bucketMs }),
      readConditionLimitsOf(tx, names),
    ]);
    const bucketsOf = Map.groupBy(rows, (row) => row.system);
    return {
      ...activity,
      bucketMs,
      lanes: names.map((system) => ({
        buckets: (bucketsOf.get(system) ?? []).map(toBucket),
        cpuLimit: limitsOf(system)?.cpu.percent,
        stretches: stretches.get(system) ?? [],
        system,
        unpaired: unpairedOnes.has(system),
      })),
      systems: names.toSorted(byName),
      unpaired,
    };
  });
