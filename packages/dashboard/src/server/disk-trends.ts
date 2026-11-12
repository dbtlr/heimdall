import type { SQL } from 'bun';

import { diskGrowth } from '../lib/disk-growth.ts';
import type { DiskReading } from '../lib/disk-growth.ts';
import type { DiskTrend } from './system-detail-types.ts';

// How far back a mount's growth is fitted, whatever range a page shows.
export const GROWTH_DAYS = 7;

// Each mount of `system`'s growth over the 7 days up to its newest disk rollup
// at or before `now`, from the 5-minute rollups: at most 2016 buckets a mount.
// Ending at the newest reading rather than at `now` fits a System that has gone
// silent on the readings it sent, as the newest sample the page shows.
export const readDiskTrends = async (
  sql: SQL,
  { now, system }: { now: number; system: string },
): Promise<DiskTrend[]> => {
  const rows: { bucket: Date; mount: string; total: number; used: number }[] = await sql`
    WITH newest AS (
      SELECT max(bucket) AS bucket FROM disk_rollups
      WHERE system = ${system} AND bucket <= ${new Date(now)}
    )
    SELECT r.bucket, r.mount, r.used_max::float8 AS used, r.total_max::float8 AS total
    FROM disk_rollups r, newest
    WHERE r.system = ${system}
      AND r.bucket <= newest.bucket
      AND r.bucket >= newest.bucket - make_interval(days => ${GROWTH_DAYS}::int)
    ORDER BY r.mount, r.bucket
  `;
  const readings = new Map<string, DiskReading[]>();
  for (const row of rows) {
    const held = readings.get(row.mount) ?? [];
    held.push({ t: row.bucket.getTime(), totalBytes: row.total, usedBytes: row.used });
    readings.set(row.mount, held);
  }
  return [...readings].map(([mount, points]) => {
    const growth = diskGrowth(points);
    return {
      growth: growth === undefined ? undefined : { bytesPerDay: growth.bytesPerDay },
      mount,
    };
  });
};
