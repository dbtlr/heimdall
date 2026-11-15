import type { SQL } from 'bun';

import type { DiskTrend } from './system-detail-types.ts';

// How far back a mount's growth is fitted, whatever range a page shows.
export const GROWTH_DAYS = 7;
// Pool free space can jitter dataset sizes; only a change exceeding 1% of
// the earlier total starts a new volume's fit.
export const SIZE_CHANGE_FRACTION = 0.01;

type FittedDiskTrend = DiskTrend & {
  count: number;
  firstAt: number;
  lastAt: number;
  latestUsedBytes: number;
  totalBytes: number;
};

// One SQL summary per mount, ending at the System's newest disk rollup.
// A material size change starts a fit after the mixed change bucket, even
// when a mount returns to an earlier size. The optional mount filter does not
// move the System-wide newest reading that anchors both pages.
export const readDiskTrends = async (
  sql: SQL,
  { now, system, mount = null }: { now: number; system: string; mount?: string | null },
): Promise<FittedDiskTrend[]> => {
  const rows: {
    mount: string;
    slope: number | null;
    count: number;
    first_at: Date | null;
    size_changed: boolean;
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
        AND (${mount}::text IS NULL OR r.mount = ${mount})
        AND r.bucket <= newest.bucket
        AND r.bucket >= newest.bucket - make_interval(days => ${GROWTH_DAYS}::int)
    ), segmented AS (
      SELECT *, max(bucket) FILTER (
        WHERE previous_total IS NOT NULL AND abs(total_max - previous_total) > abs(previous_total) * ${SIZE_CHANGE_FRACTION}
      ) OVER (PARTITION BY mount) AS changed_at
      FROM windowed
    ), eligible AS (
      SELECT *, changed_at IS NULL OR bucket > changed_at AS fits FROM segmented
    )
    SELECT mount,
      regr_slope(used_max::float8, day) FILTER (WHERE fits) AS slope,
      (count(*) FILTER (WHERE fits))::int AS count,
      min(bucket) FILTER (WHERE fits) AS first_at, max(bucket) AS last_at,
      bool_or(changed_at IS NOT NULL) AS size_changed,
      (array_agg(used_max::float8 ORDER BY bucket DESC))[1] AS latest_used,
      (array_agg(total_max::float8 ORDER BY bucket DESC))[1] AS total
    FROM eligible
    GROUP BY mount ORDER BY mount
  `;
  return rows.map((row) => ({
    count: row.count,
    firstAt: row.first_at?.getTime() ?? row.last_at.getTime(),
    growth:
      row.slope === null ||
      row.first_at === null ||
      row.last_at.getTime() - row.first_at.getTime() < 86_400_000
        ? undefined
        : { bytesPerDay: row.slope },
    lastAt: row.last_at.getTime(),
    latestUsedBytes: row.latest_used,
    mount: row.mount,
    sizeChanged: row.size_changed,
    spanMs: row.first_at === null ? 0 : row.last_at.getTime() - row.first_at.getTime(),
    totalBytes: row.total,
  }));
};
