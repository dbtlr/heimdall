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

type DayRow = {
  by_now_usd: number;
  priced_cost_usd: number;
  requests: number;
  unpriced_requests: number;
};

// Each of `days`' cost, from its requests at list prices, and what it had
// spent by its cutoff, in one statement however many Sessions there are. The
// Sessions are found by their stored stretches, as the Agents page finds them,
// and their requests by Session and time.
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
    WITH spans AS MATERIALIZED (
      SELECT harness, system, source, session_id
      FROM insight.session_stretches
      GROUP BY harness, system, source, session_id
      HAVING max(ended_at) >= ${from} AND min(started_at) < ${to}
    ),
    priced AS (
      SELECT r.at, r.cost_usd
      FROM spans k
      CROSS JOIN LATERAL (
        SELECT x.at, x.cost_usd
        FROM insight.requests x
        WHERE (x.harness, x.system, x.source, x.session_id)
            = (k.harness, k.system, k.source, k.session_id)
          AND x.at >= ${from} AND x.at < ${to}
      ) r
    )
    SELECT count(r.at)::float8 AS requests,
           coalesce(sum(r.cost_usd), 0)::float8 AS priced_cost_usd,
           (count(r.at) FILTER (WHERE r.cost_usd IS NULL))::float8 AS unpriced_requests,
           coalesce(sum(r.cost_usd) FILTER (WHERE r.at <= w.cutoff_at), 0)::float8 AS by_now_usd
    FROM jsonb_to_recordset(${windows}::text::jsonb)
      AS w (i int, start_at timestamptz, end_at timestamptz, cutoff_at timestamptz)
    LEFT JOIN priced r ON r.at >= w.start_at AND r.at < w.end_at
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
// spent by now, and the running Sessions, each priced over all its requests.
// A fixed number of statements however many Sessions or Systems there are.
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
      to: new Date(now),
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
