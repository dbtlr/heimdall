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
// model, and working directory, summed in the database from the requests of
// the Sessions with one in the period. The Sessions are the spans' (see
// sessionSpans) and each request is read through its Session's key, so the
// cost follows the period's length and not the archive's. Call it inside a
// snapshot.
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
      SELECT *
      FROM jsonb_to_recordset(${windows}::text::jsonb) AS j (i int, start_at timestamptz, end_at timestamptz)
    ),
    spans AS MATERIALIZED (${sessionSpans(sql, { from, to })})
    SELECT w.i AS bucket, k.harness, k.system, r.model,
           s.repository, coalesce(s.last_cwd, s.first_cwd) AS cwd,
           coalesce(sum(r.cost_usd), 0)::float8 AS priced_cost_usd,
           count(*) FILTER (WHERE r.cost_usd IS NULL)::float8 AS unpriced_requests
    FROM spans k
    JOIN insight.sessions s
      ON (s.harness, s.system, s.source, s.session_id)
       = (k.harness, k.system, k.source, k.session_id)
    CROSS JOIN windows w
    JOIN insight.requests r
      ON (r.harness, r.system, r.source, r.session_id)
       = (k.harness, k.system, k.source, k.session_id)
     AND r.at >= greatest(w.start_at, ${from}) AND r.at < w.end_at AND r.at <= ${to}
    GROUP BY w.i, k.harness, k.system, r.model, s.repository, coalesce(s.last_cwd, s.first_cwd)
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
