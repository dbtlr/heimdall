import type { SQL } from 'bun';

import { isRunning, localDays, RUNNING_MS, shownRunning, usualByNow } from '../lib/home-agents.ts';
import type { LocalDay } from '../lib/home-agents.ts';
import type { PeriodTotals } from './agents-overview-types.ts';
import { periodTotals, readPeriodSessions, todayPeriod } from './agents-overview.ts';
import type { HomeAgents } from './home-types.ts';

// How many local days the bars show, today among them.
const BAR_DAYS = 7;

// How many days before today "usually by now" is counted over.
const USUAL_DAYS = 7;

// The bound past every request a running Session can have: a Collector's
// clock running ahead stamps a request after the dashboard's now, and that
// request is no older than RUNNING_MS too.
const NO_LATER = new Date('9999-12-31T00:00:00Z');

type DayRow = {
  by_now_usd: number;
  priced_cost_usd: number;
  requests: number;
  unpriced_requests: number;
};

// Each of `days`' cost at list prices, and what it had spent by its cutoff,
// in one statement however many Sessions there are. As on the Agents page
// (ADR-0016), a Session within one day, wholly before or wholly after its
// cutoff, takes its stored total; only a Session crossing a midnight or a
// cutoff is priced request by request.
const readDayCosts = async (
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
    spans AS MATERIALIZED (
      SELECT harness, system, source, session_id,
             min(started_at) AS first_request_at, max(ended_at) AS last_request_at
      FROM insight.session_stretches
      GROUP BY harness, system, source, session_id
      HAVING max(ended_at) >= ${from} AND min(started_at) < ${to}
    ),
    costs AS (
      SELECT w.i, t.requests, t.priced_cost_usd, t.unpriced_requests, t.by_now_usd
      FROM windows w
      JOIN spans k ON k.last_request_at >= w.start_at AND k.first_request_at < w.end_at
      CROSS JOIN LATERAL (
        SELECT x.requests, x.priced_cost_usd, x.unpriced_requests,
               CASE WHEN k.last_request_at <= w.cutoff_at THEN x.priced_cost_usd END AS by_now_usd
        FROM insight.session_totals x
        WHERE (x.harness, x.system, x.source, x.session_id)
            = (k.harness, k.system, k.source, k.session_id)
          AND k.first_request_at >= w.start_at AND k.last_request_at < w.end_at
          AND (k.last_request_at <= w.cutoff_at OR k.first_request_at > w.cutoff_at)
        UNION ALL
        SELECT count(*), sum(r.cost_usd), count(*) FILTER (WHERE r.cost_usd IS NULL),
               sum(r.cost_usd) FILTER (WHERE r.at <= w.cutoff_at)
        FROM insight.requests r
        WHERE (r.harness, r.system, r.source, r.session_id)
            = (k.harness, k.system, k.source, k.session_id)
          AND NOT (k.first_request_at >= w.start_at AND k.last_request_at < w.end_at
                   AND (k.last_request_at <= w.cutoff_at OR k.first_request_at > w.cutoff_at))
          AND r.at >= w.start_at AND r.at < w.end_at
        HAVING count(*) > 0
      ) t
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

// The newest request of any Session, by its stored stretches.
const readLatestRequestAt = async (sql: SQL): Promise<number | undefined> => {
  const [row]: { at: Date | null }[] = await sql`
    SELECT max(ended_at) AS at FROM insight.session_stretches
  `;
  return row?.at?.getTime();
};

// Agent work at `now` in `timeZone`, for Home's Agents card: today's cost as
// the Agents page totals it, the days before for the bars and what is usually
// spent by now, and the running Sessions, each priced over all its requests,
// even one stamped after `now`. Today's cost, like the Agents page's, counts
// requests up to `now`. A fixed number of statements however many Sessions or
// Systems there are.
// Call it inside a snapshot.
export const readHomeAgents = async (
  sql: SQL,
  { now, timeZone }: { now: number; timeZone: string },
): Promise<HomeAgents> => {
  const days = localDays(now, timeZone, USUAL_DAYS + 1);
  const today = days.at(-1);
  const earlier = days.slice(0, -1);
  const [todays, recent, earlierCosts] = await Promise.all([
    readPeriodSessions(sql, todayPeriod(now, timeZone)),
    readPeriodSessions(sql, {
      from: new Date(0),
      lastRequestFrom: new Date(now - RUNNING_MS),
      to: NO_LATER,
    }),
    readDayCosts(sql, earlier),
  ]);
  const running = shownRunning(
    recent.sessions.filter((session) => isRunning(session.lastRequestAt, now)),
    Number.POSITIVE_INFINITY,
  ).shown;
  const totals = periodTotals(todays.sessions);
  const bars = earlier.slice(1 - BAR_DAYS).map(({ start }, index) => {
    const { pricedCostUsd, requests, unpricedRequests } = earlierCosts[
      earlier.length - (BAR_DAYS - 1) + index
    ] ?? { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 };
    return { pricedCostUsd, requests, start, unpricedRequests };
  });
  return {
    days: [...bars, { ...totals, start: today?.start ?? now }],
    latestRequestAt: running.length === 0 ? await readLatestRequestAt(sql) : undefined,
    running,
    timeZone,
    today: totals,
    usualByNow: usualByNow(earlierCosts),
  };
};
