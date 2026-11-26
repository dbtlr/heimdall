import type { SQL } from 'bun';

import { chartBuckets } from '../lib/agents-chart.ts';
import { NO_KEY } from './agents-overview-types.ts';
import type { AgentsRange, CostCell, CostChart } from './agents-overview-types.ts';
import type { Period } from './agents-overview.ts';
import { projectOf } from './fleet-overview.ts';
import { sessionSpans } from './session-spans.ts';
import { settleBoth } from './snapshot.ts';

type CellRow = {
  bucket: number;
  cwd: string | null;
  harness: string;
  model: string;
  priced_cost_usd: number;
  repository: string | null;
  system: string;
  unpriced_requests: number;
};

// A Session the period's Session rows list whole, with its stored model
// totals: [model, requests, priced cost, unpriced requests].
export type WholeSession = {
  cwd: string | null;
  firstRequestAt: number;
  harness: string;
  lastRequestAt: number;
  models: readonly (readonly [string, number, number | null, number])[];
  repository: string | null;
  system: string;
};

// The buckets' windows: each from its start, or the period's for the first.
const windowsOf = (buckets: CostChart['buckets'], from: Date) =>
  buckets.map(({ end, start }, index) => ({
    end,
    i: index,
    start: Math.max(start, from.getTime()),
  }));

// What requests in the period cost in each of `buckets`, per Harness, System,
// model, and working directory, in one statement however many Sessions there
// are. As for the Session and model totals (ADR-0016), a Session whose whole
// span starts and ends inside one bucket takes its stored model totals. A
// Session that starts before the period or crosses a bucket's edge uses the
// window's model totals, which can reuse the stored intervals inside it. The
// spans select the Sessions from the period and limit them to `system` for a
// System page. Call it inside a snapshot.
export const readCells = async (
  sql: SQL,
  { from, project, to }: Period,
  buckets: CostChart['buckets'],
  system?: string,
): Promise<CellRow[]> => {
  const windows = JSON.stringify(
    buckets.map(({ end, start }, index) => ({
      end_at: new Date(end).toISOString(),
      i: index,
      start_at: new Date(start).toISOString(),
    })),
  );
  return sql`
    WITH windows AS MATERIALIZED (
      SELECT j.i, greatest(j.start_at, ${from}) AS start_at, j.end_at
      FROM jsonb_to_recordset(${windows}::text::jsonb) AS j (i int, start_at timestamptz, end_at timestamptz)
    ),
    spans AS MATERIALIZED (
      SELECT k.*, s.repository, coalesce(s.last_cwd, s.first_cwd) AS cwd
      FROM (${sessionSpans(sql, { from, project, system, to })}) k
      CROSS JOIN LATERAL (
        SELECT x.repository, x.first_cwd, x.last_cwd
        FROM insight.sessions x
        WHERE (x.harness, x.system, x.source, x.session_id)
            = (k.harness, k.system, k.source, k.session_id)
        OFFSET 0
      ) s
    )
    SELECT w.i AS bucket, k.harness, k.system, t.model, k.repository, k.cwd,
           coalesce(sum(t.priced_cost_usd), 0)::float8 AS priced_cost_usd,
           sum(t.unpriced_requests)::float8 AS unpriced_requests
    FROM windows w
    JOIN spans k ON k.last_request_at >= w.start_at AND k.first_request_at < w.end_at
    CROSS JOIN LATERAL (
      SELECT x.model, x.requests, x.priced_cost_usd, x.unpriced_requests
      FROM insight.session_model_totals x
      WHERE (x.harness, x.system, x.source, x.session_id)
          = (k.harness, k.system, k.source, k.session_id)
        AND k.first_request_at >= w.start_at AND k.last_request_at < w.end_at
        AND k.last_request_at <= ${to}
      UNION ALL
      SELECT r.model, r.requests, r.priced_cost_usd, r.unpriced_requests
      FROM session_window_model_totals(k.harness, k.system, k.source, k.session_id,
        w.start_at, least(w.end_at, ${to}::timestamptz + interval '1 microsecond')) r
      WHERE NOT (k.first_request_at >= w.start_at AND k.last_request_at < w.end_at
                 AND k.last_request_at <= ${to})
    ) t
    WHERE t.requests > 0
    GROUP BY w.i, k.harness, k.system, t.model, k.repository, k.cwd
  `;
};

// readCells for a chart's buckets, which follow each other without a gap,
// leaving out each Session whose whole span starts and ends inside one
// bucket: the caller has its stored model totals already (see wholeCells).
// Each other Session reads every bucket's model totals at once, which reuse
// the stored intervals inside each bucket. Call it inside a snapshot.
const readCrossingCells = async (
  sql: SQL,
  { from, project, to }: Period,
  buckets: CostChart['buckets'],
): Promise<CellRow[]> => {
  const windows = JSON.stringify(
    windowsOf(buckets, from).map(({ end, i, start }) => ({
      end_at: new Date(end).toISOString(),
      i,
      start_at: new Date(start).toISOString(),
    })),
  );
  // A Session lies whole in one bucket when its first and last request fall
  // in the same window; the last edge is the period's end, as in readCells.
  return sql`
    WITH windows AS MATERIALIZED (
      SELECT j.i, j.start_at, j.end_at
      FROM jsonb_to_recordset(${windows}::text::jsonb) AS j (i int, start_at timestamptz, end_at timestamptz)
    ),
    edges AS MATERIALIZED (
      SELECT array_agg(w.start_at ORDER BY w.i)
               || least(max(w.end_at), ${to}::timestamptz + interval '1 microsecond') AS edges,
             count(*)::int AS windows
      FROM windows w
    ),
    spans AS MATERIALIZED (
      SELECT k.*,
             width_bucket(k.first_request_at, e.edges) = width_bucket(k.last_request_at, e.edges)
               AND width_bucket(k.first_request_at, e.edges) BETWEEN 1 AND e.windows AS whole
      FROM (${sessionSpans(sql, { from, project, to })}) k, edges e
    ),
    -- Each Session's metadata, read once by its key.
    keyed AS MATERIALIZED (
      SELECT k.*, s.repository, s.cwd
      FROM spans k
      CROSS JOIN LATERAL (
        SELECT x.repository, coalesce(x.last_cwd, x.first_cwd) AS cwd
        FROM insight.sessions x
        WHERE (x.harness, x.system, x.source, x.session_id)
            = (k.harness, k.system, k.source, k.session_id)
        OFFSET 0
      ) s
      WHERE NOT k.whole
    )
    SELECT t.window_index - 1 AS bucket, k.harness, k.system, t.model, k.repository, k.cwd,
           coalesce(sum(t.priced_cost_usd), 0)::float8 AS priced_cost_usd,
           sum(t.unpriced_requests)::float8 AS unpriced_requests
    FROM keyed k, edges e
    CROSS JOIN LATERAL session_windows_model_totals(k.harness, k.system, k.source, k.session_id,
      e.edges) t
    WHERE t.requests > 0
    GROUP BY t.window_index, k.harness, k.system, t.model, k.repository, k.cwd
  `;
};

// The cells of the Sessions listed whole whose span starts and ends inside
// one bucket, from their stored model totals, as readCells reads them. A
// timestamp read in milliseconds compares with a bucket's edges, which are
// whole milliseconds, as PostgreSQL compares it.
const wholeCells = (
  sessions: readonly WholeSession[],
  buckets: CostChart['buckets'],
  from: Date,
): CellRow[] => {
  const windows = windowsOf(buckets, from);
  const cells: CellRow[] = [];
  for (const session of sessions) {
    const window = windows.find(
      ({ end, start }) => session.firstRequestAt >= start && session.firstRequestAt < end,
    );
    if (window === undefined || session.lastRequestAt >= window.end) {
      continue;
    }
    for (const [model, requests, pricedCostUsd, unpricedRequests] of session.models) {
      if (requests > 0) {
        cells.push({
          bucket: window.i,
          cwd: session.cwd,
          harness: session.harness,
          model,
          priced_cost_usd: pricedCostUsd ?? 0,
          repository: session.repository,
          system: session.system,
          unpriced_requests: unpricedRequests,
        });
      }
    }
  }
  return cells;
};

// `bucket` read on to `to`, the period's last instant, when it holds `now`. A
// request stamped ahead of `now` but within the period can fall past the end
// of the bucket holding now, and counts in it, so the bars still sum to the
// period's total. A bucket that ends by `now` is read as it is.
export const throughPeriodEnd = <Bucket extends { end: number }>(
  bucket: Bucket,
  now: number,
  to: Date,
): Bucket =>
  bucket.end > now ? { ...bucket, end: Math.max(bucket.end, to.getTime() + 1) } : bucket;

// The cost chart of `period`: its bars, a local hour each for Today and a
// local day for the longer ranges, and the cost in each by every key. The
// Sessions the period lists whole are given, with their stored model totals,
// so only the others are read. Cells that fall on the same project merge, as
// projects are named from the repository or the directory. The last bar holds
// `now` and reads to the period's end (see throughPeriodEnd).
export const readCostChart = async (
  sql: SQL,
  {
    now,
    period,
    range,
    timeZone,
    whole,
  }: {
    now: number;
    period: Period;
    range: AgentsRange;
    timeZone: string;
    whole: Promise<readonly WholeSession[]>;
  },
): Promise<CostChart> => {
  const { buckets, unit } = chartBuckets(range, period.from.getTime(), now, timeZone);
  const windows = buckets.map((bucket) => throughPeriodEnd(bucket, now, period.to));
  const [read, given] = await settleBoth(readCrossingCells(sql, period, windows), whole);
  const merged = new Map<string, CostCell>();
  for (const row of [...wholeCells(given, windows, period.from), ...read]) {
    const cell: CostCell = {
      bucket: row.bucket,
      harness: row.harness,
      model: row.model,
      pricedCostUsd: row.priced_cost_usd,
      project: projectOf(row.repository, row.cwd) ?? NO_KEY,
      system: row.system,
      unpricedRequests: row.unpriced_requests,
    };
    const id = JSON.stringify([cell.bucket, cell.harness, cell.system, cell.model, cell.project]);
    const seen = merged.get(id);
    if (seen === undefined) {
      merged.set(id, cell);
    } else {
      seen.pricedCostUsd += cell.pricedCostUsd;
      seen.unpricedRequests += cell.unpricedRequests;
    }
  }
  return { buckets, cells: [...merged.values()], unit };
};
