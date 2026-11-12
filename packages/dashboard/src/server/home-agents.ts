import type { SQL } from 'bun';

import { isRunning, localDays, RUNNING_MS, shownRunning, usualByNow } from '../lib/home-agents.ts';
import { periodTotals, readPeriodSessions, todayPeriod } from './agents-overview.ts';
import { readDayCosts, USUAL_DAYS } from './day-costs.ts';
import type { HomeAgents } from './home-types.ts';

// How many local days the bars show, today among them.
const BAR_DAYS = 7;

// The bound past every request a running Session can have: a Collector's
// clock running ahead stamps a request after the dashboard's now, and that
// request is no older than RUNNING_MS too.
const NO_LATER = new Date('9999-12-31T00:00:00Z');

// The newest request of any Session, by its stored stretches. The planner
// cannot read the view in the order of its index, so the newest stored end,
// the index's last entry, bounds what the view reads. A Session being derived
// again has no stored stretches, so that end is the view's; should the view
// hide it anyway, every stretch is read, as before.
const readLatestRequestAt = async (sql: SQL): Promise<number | undefined> => {
  const [row]: { at: Date | null }[] = await sql`
    SELECT coalesce(
      (SELECT v.at
       FROM (SELECT max(ended_at) AS newest FROM stored_session_stretches) b
       CROSS JOIN LATERAL (
         SELECT max(x.ended_at) AS at FROM insight.session_stretches x WHERE x.ended_at >= b.newest
       ) v),
      (SELECT max(ended_at) FROM insight.session_stretches)
    ) AS at
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
