import type { SQL } from 'bun';

import { diskGrowth } from '../lib/disk-growth.ts';
import type { DiskReading } from '../lib/disk-growth.ts';
import type { DiskTrend } from './system-detail-types.ts';

const DAY_MS = 86_400_000;

// How far back a mount's growth is fitted, whatever range a page shows.
export const GROWTH_DAYS = 7;

// Each mount of `system`'s growth over the 7 days before `now`, from the
// 5-minute disk rollups: at most 2016 buckets a mount.
export const readDiskTrends = async (
  sql: SQL,
  { now, system }: { now: number; system: string },
): Promise<DiskTrend[]> => {
  const rows: { bucket: Date; mount: string; total: number; used: number }[] = await sql`
    SELECT bucket, mount, used_max::float8 AS used, total_max::float8 AS total
    FROM disk_rollups
    WHERE system = ${system}
      AND bucket >= ${new Date(now - GROWTH_DAYS * DAY_MS)} AND bucket <= ${new Date(now)}
    ORDER BY mount, bucket
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
