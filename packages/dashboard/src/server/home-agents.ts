import type { SQL } from 'bun';

import { localDays, shownRunning, usualByNow } from '../lib/home-agents.ts';
import {
  periodEnd,
  periodTotals,
  readPeriodSessions,
  readRunningSessions,
  todaySessionsPeriod,
} from './agents-overview.ts';
import { readDayCosts, USUAL_DAYS } from './day-costs.ts';
import type { HomeAgents } from './home-types.ts';

// How many local days the bars show, today among them.
const BAR_DAYS = 7;

// The newest request of any Session stamped no later than `periodEnd(now)`,
// so it ignores a request Running ignores. A Session whose last request is by
// then gives it from the stored spans' end-time index, newest first, with
// insight.session_spans' filter applied by hand: the view is a security
// barrier, so the planner cannot read it in the index's order. A Session
// whose last request is later, of which there are few, gives its latest
// request by then, read through its key and time.
const readLatestRequestAt = async (sql: SQL, now: number): Promise<number | undefined> => {
  const to = periodEnd(now);
  const [row]: { at: Date | null }[] = await sql`
    SELECT greatest(
      (SELECT k.last_request_at FROM stored_session_spans k
       WHERE k.last_request_at <= ${to}
         AND NOT EXISTS (
           SELECT 1 FROM rederiving_sessions x
           WHERE (x.harness, x.system, x.source, x.session_id)
               = (k.harness, k.system, k.source, k.session_id)
         )
       ORDER BY k.last_request_at DESC LIMIT 1),
      (SELECT max(r.at)
       FROM insight.session_spans k
       CROSS JOIN LATERAL (
         SELECT max(y.at) AS at FROM insight.requests y
         WHERE (y.harness, y.system, y.source, y.session_id)
             = (k.harness, k.system, k.source, k.session_id)
           AND y.at >= k.first_request_at AND y.at <= ${to}
       ) r
       WHERE k.last_request_at > ${to} AND k.first_request_at <= ${to})
    ) AS at
  `;
  return row?.at?.getTime();
};

// Agent work at `now` in `timeZone`, for Home's Agents card: today's cost as
// the Agents page totals it, the days before for the bars and what is usually
// spent by now, and the running Sessions. Today's cost and the running
// Sessions, like the Agents page's, count requests up to `periodEnd(now)`. A
// fixed number of statements however many Sessions or Systems there are.
// Call it inside a snapshot.
export const readHomeAgents = async (
  sql: SQL,
  { now, timeZone }: { now: number; timeZone: string },
): Promise<HomeAgents> => {
  const days = localDays(now, timeZone, USUAL_DAYS + 1);
  const today = days.at(-1);
  const earlier = days.slice(0, -1);
  const [todays, runningSessions, earlierCosts] = await Promise.all([
    readPeriodSessions(sql, todaySessionsPeriod(now, timeZone)),
    readRunningSessions(sql, { now }),
    readDayCosts(sql, earlier),
  ]);
  const running = shownRunning(runningSessions, Number.POSITIVE_INFINITY).shown;
  const totals = periodTotals(todays.sessions);
  const bars = earlier.slice(1 - BAR_DAYS).map(({ start }, index) => {
    const { pricedCostUsd, requests, unpricedRequests } = earlierCosts[
      earlier.length - (BAR_DAYS - 1) + index
    ] ?? { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 };
    return { pricedCostUsd, requests, start, unpricedRequests };
  });
  return {
    days: [...bars, { ...totals, start: today?.start ?? now }],
    latestRequestAt: running.length === 0 ? await readLatestRequestAt(sql, now) : undefined,
    running,
    timeZone,
    today: totals,
    usualByNow: usualByNow(earlierCosts),
  };
};
