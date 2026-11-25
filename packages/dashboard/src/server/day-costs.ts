import type { SQL } from 'bun';

import type { LocalDay } from '../lib/home-agents.ts';
import type { PeriodTotals } from './agents-overview-types.ts';
import { sessionSpans } from './session-spans.ts';

// How many days before today "usually by now" is counted over.
export const USUAL_DAYS = 7;

type DayRow = {
  by_now_usd: number;
  priced_cost_usd: number;
  requests: number;
  unpriced_requests: number;
};

// Each of `days`' cost at list prices, and what it had spent by its cutoff,
// in one statement however many Sessions there are. As on the Agents page
// (ADR-0016), a Session within one day takes its stored total, and one
// crossing a midnight reads the day's window, which a midnight bounds on an
// interval's edge. What it had spent by the cutoff is that cost when its
// requests that day end by then, none when they start after it, and else
// the window up to the cutoff, so only a Session crossing the cutoff prices
// the requests in the one interval the cutoff cuts.
// A Session whose first request is at the last day's end joins no day.
export const readDayCosts = async (
  sql: SQL,
  days: readonly LocalDay[],
): Promise<(PeriodTotals & { byNowUsd: number })[]> => {
  const from = new Date(days[0]?.start ?? 0);
  const to = new Date(days.at(-1)?.end ?? 0);
  const windows = JSON.stringify(
    days.map(({ cutoff, end, start }, index) => ({
      cutoff_at: new Date(cutoff).toISOString(),
      end_at: new Date(end).toISOString(),
      i: index,
      start_at: new Date(start).toISOString(),
    })),
  );
  const rows: DayRow[] = await sql`
    WITH windows AS MATERIALIZED (
      SELECT *
      FROM jsonb_to_recordset(${windows}::text::jsonb)
        AS j (i int, start_at timestamptz, end_at timestamptz, cutoff_at timestamptz)
    ),
    spans AS MATERIALIZED (${sessionSpans(sql, { from, to })}),
    costs AS (
      SELECT w.i, t.requests, t.priced_cost_usd, t.unpriced_requests,
             CASE WHEN k.last_request_at <= w.cutoff_at THEN t.priced_cost_usd ELSE b.by_now_usd END
               AS by_now_usd
      FROM windows w
      JOIN spans k ON k.last_request_at >= w.start_at AND k.first_request_at < w.end_at
      CROSS JOIN LATERAL (
        SELECT x.requests, x.priced_cost_usd, x.unpriced_requests
        FROM insight.session_totals x
        WHERE (x.harness, x.system, x.source, x.session_id)
            = (k.harness, k.system, k.source, k.session_id)
          AND k.first_request_at >= w.start_at AND k.last_request_at < w.end_at
        UNION ALL
        SELECT sum(r.requests)::bigint, sum(r.priced_cost_usd), sum(r.unpriced_requests)::bigint
        FROM session_window_model_totals(k.harness, k.system, k.source, k.session_id,
          w.start_at, w.end_at) r
        WHERE NOT (k.first_request_at >= w.start_at AND k.last_request_at < w.end_at)
        HAVING count(*) > 0
      ) t
      LEFT JOIN LATERAL (
        SELECT sum(r.priced_cost_usd) AS by_now_usd
        FROM session_window_model_totals(k.harness, k.system, k.source, k.session_id,
          w.start_at, least(w.end_at, w.cutoff_at + interval '1 microsecond')) r
        WHERE k.first_request_at <= w.cutoff_at AND k.last_request_at > w.cutoff_at
      ) b ON true
    )
    SELECT coalesce(sum(c.requests), 0)::float8 AS requests,
           coalesce(sum(c.priced_cost_usd), 0)::float8 AS priced_cost_usd,
           coalesce(sum(c.unpriced_requests), 0)::float8 AS unpriced_requests,
           coalesce(sum(c.by_now_usd), 0)::float8 AS by_now_usd
    FROM windows w
    LEFT JOIN costs c ON c.i = w.i
    GROUP BY w.i
    ORDER BY w.i
  `;
  return rows.map((row) => ({
    byNowUsd: row.by_now_usd,
    pricedCostUsd: row.priced_cost_usd,
    requests: row.requests,
    unpricedRequests: row.unpriced_requests,
  }));
};
