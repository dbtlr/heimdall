import type { SQL } from 'bun';

import type { DiskTrend } from './system-detail-types.ts';

// How far back a mount's growth is fitted, whatever range a page shows.
export const GROWTH_DAYS = 7;

type FittedDiskTrend = DiskTrend & {
  count: number;
  firstAt: number;
  lastAt: number;
  latestUsedBytes: number;
  totalBytes: number;
};

// One SQL summary per mount, ending at the System's newest disk rollup.
// A size change starts a new fit, even when a mount returns to an earlier size.
export const readDiskTrends = async (
  sql: SQL,
  { now, system }: { now: number; system: string },
): Promise<FittedDiskTrend[]> => {
  const rows: {
    mount: string;
    slope: number | null;
    count: number;
    first_at: Date;
    last_at: Date;
    latest_used: number;
    total: number;
  }[] = await sql`
    WITH newest AS (
      SELECT max(bucket) AS bucket FROM disk_rollups
      WHERE system = ${system} AND bucket <= ${new Date(now)}
    ), windowed AS (
      SELECT r.*,
        extract(epoch FROM (r.bucket - newest.bucket))::float8 / 86400 AS day,
        lag(total_max) OVER (PARTITION BY mount ORDER BY r.bucket) AS previous_total
      FROM disk_rollups r, newest
      WHERE r.system = ${system}
        AND r.bucket <= newest.bucket
        AND r.bucket >= newest.bucket - make_interval(days => ${GROWTH_DAYS}::int)
    ), segmented AS (
      SELECT *, max(bucket) FILTER (
        WHERE previous_total IS NOT NULL AND previous_total <> total_max
      ) OVER (PARTITION BY mount) AS changed_at
      FROM windowed
    )
    SELECT mount,
      regr_slope(used_max::float8, day) AS slope,
      regr_count(used_max::float8, day)::int AS count,
      min(bucket) AS first_at, max(bucket) AS last_at,
      (array_agg(used_max::float8 ORDER BY bucket DESC))[1] AS latest_used,
      (array_agg(total_max::float8 ORDER BY bucket DESC))[1] AS total
    FROM segmented
    WHERE changed_at IS NULL OR bucket >= changed_at
    GROUP BY mount ORDER BY mount
  `;
  return rows.map((row) => ({
    count: row.count,
    firstAt: row.first_at.getTime(),
    growth:
      row.slope === null || row.last_at.getTime() - row.first_at.getTime() < 86_400_000
        ? undefined
        : { bytesPerDay: row.slope },
    lastAt: row.last_at.getTime(),
    latestUsedBytes: row.latest_used,
    mount: row.mount,
    totalBytes: row.total,
  }));
};
