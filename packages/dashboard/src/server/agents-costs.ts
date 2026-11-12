import type { SQL } from 'bun';

import { chartBuckets } from '../lib/agents-chart.ts';
import { NO_KEY } from './agents-overview-types.ts';
import type { AgentsRange, CostCell, CostChart } from './agents-overview-types.ts';
import type { Period } from './agents-overview.ts';
import { projectOf } from './fleet-overview.ts';
import { sessionSpans } from './session-spans.ts';

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

// What requests in the period cost in each of `buckets`, per Harness, System,
// model, and working directory, in one statement however many Sessions there
// are. As for the Session and model totals (ADR-0016), a Session whose
// requests in the period all fall in one bucket takes its stored model totals;
// only a Session crossing a bucket's edge or the period's is priced request by
// request, and only its requests in that bucket, read through its key and
// time. The Sessions are the spans' (see sessionSpans), so the cost follows
// the period's Sessions and not the archive. Call it inside a snapshot.
const readCells = async (
  sql: SQL,
  { from, to }: Period,
  buckets: CostChart['buckets'],
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
      FROM (${sessionSpans(sql, { from, to })}) k
      CROSS JOIN LATERAL (
        SELECT x.repository, x.first_cwd, x.last_cwd
        FROM insight.sessions x
        WHERE (x.harness, x.system, x.source, x.session_id)
            = (k.harness, k.system, k.source, k.session_id)
        OFFSET 0
      ) s
    )
    SELECT w.i AS bucket, k.harness, k.system, t.model, k.repository, k.cwd,
           coalesce(t.priced_cost_usd, 0)::float8 AS priced_cost_usd,
           t.unpriced_requests::float8 AS unpriced_requests
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
      SELECT r.model, count(*), sum(r.cost_usd), count(*) FILTER (WHERE r.cost_usd IS NULL)
      FROM insight.requests r
      WHERE (r.harness, r.system, r.source, r.session_id)
          = (k.harness, k.system, k.source, k.session_id)
        AND NOT (k.first_request_at >= w.start_at AND k.last_request_at < w.end_at
                 AND k.last_request_at <= ${to})
        AND r.at >= w.start_at AND r.at < w.end_at AND r.at <= ${to}
      GROUP BY r.model
    ) t
    WHERE t.requests > 0
  `;
};

// The cost chart of `period`: its bars, a local hour each for Today and a
// local day for the longer ranges, and the cost in each by every key. Cells
// that fall on the same project merge, as projects are named from the
// repository or the directory.
export const readCostChart = async (
  sql: SQL,
  {
    now,
    period,
    range,
    timeZone,
  }: { now: number; period: Period; range: AgentsRange; timeZone: string },
): Promise<CostChart> => {
  const { buckets, unit } = chartBuckets(range, period.from.getTime(), now, timeZone);
  const merged = new Map<string, CostCell>();
  for (const row of await readCells(sql, period, buckets)) {
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
