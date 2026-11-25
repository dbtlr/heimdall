import { FUTURE_SAMPLE_TOLERANCE_MS } from '@heimdall/schema';
import type { SQL } from 'bun';

import { breakdownTotals } from '../lib/agents-breakdown.ts';
import { agentsSearch, sessionsQueryOf } from '../lib/agents-search.ts';
import { sessionsPage } from '../lib/agents-sessions.ts';
import { isRunning, localDays, RUNNING_MS, usualByNow } from '../lib/home-agents.ts';
import { readCostChart } from './agents-costs.ts';
import type { WholeSession } from './agents-costs.ts';
import type {
  AgentsOverview,
  AgentsRange,
  AgentsSession,
  ModelTotals,
  PeriodOverview,
  PeriodTotals,
  SessionsQuery,
} from './agents-overview-types.ts';
import { readDayCosts, USUAL_DAYS } from './day-costs.ts';
import { projectOf } from './fleet-overview.ts';
import type { MissedTags } from './role-split-types.ts';
import { readRoleSplit } from './role-split.ts';
import { sessionSpans } from './session-spans.ts';
import { readSnapshot, settleAll, settleBoth } from './snapshot.ts';

// The period whose requests count, and the earliest latest request that
// selects a Session, `from` unless given: Home's running Sessions are those
// with a recent request, each priced over all of its requests.
export type Period = {
  from: Date;
  lastRequestFrom?: Date;
  project?: string | undefined;
  to: Date;
};

type SessionRow = {
  first_cwd: string | null;
  first_git_branch: string | null;
  first_request_at: Date;
  harness: string;
  last_cwd: string | null;
  last_git_branch: string | null;
  last_request_at: Date;
  models: ModelRow[] | null;
  priced_cost_usd: number;
  repository: string | null;
  requests: number;
  role_source: string | null;
  session_id: string;
  source: string;
  system: string;
  unpriced_requests: number;
  whole: boolean;
};

type ModelRow = [
  model: string,
  requests: number,
  pricedCostUsd: number | null,
  unpricedRequests: number,
];

// Stored stretches include subagents. Whole Sessions take the Hub's stored
// Session and model totals. When a Session crosses a boundary, the same
// window model totals supply both figures and can reuse stored intervals.
const readSessionRows = (
  sql: SQL,
  { from, lastRequestFrom = from, project, to }: Period,
): Promise<SessionRow[]> => {
  // The brief windows for Today and Running have few keys. Keep each totals
  // read on its key even when the archive's statistics favor a table scan.
  const narrow =
    to.getTime() - lastRequestFrom.getTime() <= 25 * 3_600_000 + FUTURE_SAMPLE_TOLERANCE_MS;
  const sessionTotals = narrow
    ? sql`CROSS JOIN LATERAL (
            SELECT x.requests, x.priced_cost_usd, x.unpriced_requests FROM insight.session_totals x
            WHERE (x.harness, x.system, x.source, x.session_id)
                = (k.harness, k.system, k.source, k.session_id)
            OFFSET 0
          ) x`
    : sql`JOIN insight.session_totals x USING (harness, system, source, session_id)`;
  return sql`
  WITH spans AS MATERIALIZED (${sessionSpans(sql, { from: lastRequestFrom, project, to })}),
  totals AS (
    SELECT k.harness, k.system, k.source, k.session_id, k.first_request_at, k.last_request_at,
           x.requests, x.priced_cost_usd, x.unpriced_requests,
           (SELECT json_agg(json_build_array(m.model, m.requests, m.priced_cost_usd, m.unpriced_requests))
            FROM insight.session_model_totals m
            WHERE (m.harness, m.system, m.source, m.session_id)
                = (k.harness, k.system, k.source, k.session_id) AND m.requests > 0) AS models,
           true AS whole
    FROM spans k
    ${sessionTotals}
    WHERE k.first_request_at >= ${from} AND k.last_request_at <= ${to}
      AND x.requests > 0
    UNION ALL
    SELECT k.harness, k.system, k.source, k.session_id, k.first_request_at, t.last_request_at,
           t.requests, t.priced_cost_usd, t.unpriced_requests, t.models, false
    FROM spans k
    CROSS JOIN LATERAL (
      SELECT sum(r.requests)::bigint AS requests, sum(r.priced_cost_usd) AS priced_cost_usd,
             sum(r.unpriced_requests)::bigint AS unpriced_requests,
             max(r.last_request_at) AS last_request_at,
             json_agg(json_build_array(r.model, r.requests, r.priced_cost_usd, r.unpriced_requests)) AS models
      FROM session_window_model_totals(k.harness, k.system, k.source, k.session_id,
        ${from}, ${to}::timestamptz + interval '1 microsecond') r
      HAVING count(*) > 0
    ) t
    WHERE NOT (k.first_request_at >= ${from} AND k.last_request_at <= ${to})
  )
  SELECT t.harness, t.system, t.source, t.session_id, t.first_request_at, t.last_request_at,
         s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch, s.repository, s.role_source,
         t.requests::float8 AS requests, coalesce(t.priced_cost_usd, 0)::float8 AS priced_cost_usd,
         t.unpriced_requests::float8 AS unpriced_requests, t.models, t.whole
  FROM totals t
  CROSS JOIN LATERAL (
    SELECT x.first_cwd, x.last_cwd, x.first_git_branch, x.last_git_branch, x.repository, x.role_source
    FROM insight.sessions x
    WHERE (x.harness, x.system, x.source, x.session_id)
        = (t.harness, t.system, t.source, t.session_id)
    OFFSET 0
  ) s
  ORDER BY coalesce(t.priced_cost_usd, 0) DESC, t.system, t.harness, t.source, t.session_id
`;
};

// The listed Sessions supply the model breakdown, the count of session tags,
// and the Sessions listed whole, whose stored model totals the chart reuses.
export const readSessionDetails = async (sql: SQL, period: Period) => {
  const rows = await readSessionRows(sql, period);
  const totals = new Map<string, ModelTotals>();
  const missedTags: MissedTags = { missed: 0, withRole: 0 };
  const sessions: AgentsSession[] = [];
  const whole: WholeSession[] = [];
  for (const row of rows) {
    if (row.role_source !== null) {
      missedTags.withRole += 1;
      if (row.role_source === 'preamble') {
        missedTags.missed += 1;
      }
    }
    const used = row.models ?? [];
    if (row.whole) {
      whole.push({
        cwd: row.last_cwd ?? row.first_cwd,
        firstRequestAt: row.first_request_at.getTime(),
        harness: row.harness,
        lastRequestAt: row.last_request_at.getTime(),
        models: used,
        repository: row.repository,
        system: row.system,
      });
    }
    let top: { model: string; requests: number } | undefined;
    for (const [model, requests, pricedCostUsd, unpricedRequests] of used) {
      const total = totals.get(model) ?? {
        model,
        pricedCostUsd: 0,
        requests: 0,
        unpricedRequests: 0,
      };
      total.pricedCostUsd += pricedCostUsd ?? 0;
      total.requests += requests;
      total.unpricedRequests += unpricedRequests;
      totals.set(model, total);
      if (
        top === undefined ||
        requests > top.requests ||
        (requests === top.requests && model < top.model)
      ) {
        top = { model, requests };
      }
    }
    sessions.push({
      branch: row.last_git_branch ?? row.first_git_branch ?? undefined,
      firstRequestAt: row.first_request_at.getTime(),
      harness: row.harness,
      lastRequestAt: row.last_request_at.getTime(),
      models: used.map(([model]) => model).toSorted(),
      pricedCostUsd: row.priced_cost_usd,
      project: projectOf(row.repository, row.last_cwd ?? row.first_cwd),
      requests: row.requests,
      sessionId: row.session_id,
      source: row.source,
      system: row.system,
      topModel: top?.model,
      unpricedRequests: row.unpriced_requests,
    });
  }
  return { missedTags, models: [...totals.values()], sessions, whole };
};

// The Sessions with a request in the period, most expensive first, each with
// what its requests in the period cost, and the fleet's model totals over
// them. Call it inside a snapshot.
export const readPeriodSessions = async (
  sql: SQL,
  period: Period,
): Promise<{ models: ModelTotals[]; sessions: AgentsSession[] }> => {
  const { models, sessions } = await readSessionDetails(sql, period);
  return { models, sessions };
};

// The latest a request can be stamped and still count at `now`: a Collector's
// clock running ahead stamps a request after the dashboard's now. The Hub
// stores any timestamp; the dashboard ignores a request stamped later than
// this, as the Conditions ignore a later sample, so Running, the sessions
// table, the totals, and the chart read the same requests.
export const periodEnd = (now: number): Date => new Date(now + FUTURE_SAMPLE_TOLERANCE_MS);

// The period the Agents page's table, totals, and chart read: it ends at
// `periodEnd`, not at `now`, so a request stamped slightly ahead counts in
// them as it does in Running.
export const sessionsPeriod = (period: Period, now: number): Period => ({
  ...period,
  to: periodEnd(now),
});

// The Sessions running at `now`, of one project when given, each priced over
// all its requests up to `periodEnd`, so one stamped slightly after `now`
// counts and one stamped later does not. Read apart from any
// period, since a Session can have run up to just before the period began.
// Call it inside a snapshot.
export const readRunningSessions = async (
  sql: SQL,
  { now, project }: { now: number; project?: string | undefined },
): Promise<AgentsSession[]> => {
  const { sessions } = await readPeriodSessions(sql, {
    from: new Date(0),
    lastRequestFrom: new Date(now - RUNNING_MS),
    project,
    to: periodEnd(now),
  });
  return sessions.filter(({ lastRequestAt }) => isRunning(lastRequestAt, now));
};

// The sum of the Sessions' amounts, so a total always matches the amounts shown.
export const periodTotals = (sessions: readonly PeriodTotals[]): PeriodTotals =>
  sessions.reduce(
    (totals, session) => ({
      pricedCostUsd: totals.pricedCostUsd + session.pricedCostUsd,
      requests: totals.requests + session.requests,
      unpricedRequests: totals.unpricedRequests + session.unpricedRequests,
    }),
    { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 },
  );

// Today's bounds in `timeZone`: from the first instant of the local day, which
// may be after a skipped midnight or the first of a repeated one, to `now`.
// PostgreSQL's AT TIME ZONE picks a repeated midnight later, so this is not
// left to it.
export const todayPeriod = (now: number, timeZone: string): Period => {
  const [today] = localDays(now, timeZone, 1);
  return { from: new Date(today?.start ?? now), to: new Date(now) };
};

// Today's period as the table and Running read it, past `now` by the clock tolerance.
export const todaySessionsPeriod = (now: number, timeZone: string): Period =>
  sessionsPeriod(todayPeriod(now, timeZone), now);

// The Agents page's period: Today from local midnight, else a trailing 7 or 30 days.
export const agentsPeriod = ({
  now,
  range,
  timeZone,
}: {
  now: number;
  range: AgentsRange;
  timeZone: string;
}): Period =>
  range === 'today'
    ? todayPeriod(now, timeZone)
    : {
        from: new Date(now - 86_400_000 * (range === '7d' ? 7 : 30)),
        to: new Date(now),
      };

const readEarlierDays = (sql: SQL, now: number, timeZone: string) =>
  readDayCosts(sql, localDays(now, timeZone, USUAL_DAYS + 1).slice(0, -1));

const readPeriodDetails = async (
  sql: SQL,
  {
    now,
    range,
    project,
    table = sessionsQueryOf(agentsSearch({})),
    timeZone,
  }: {
    now: number;
    range: AgentsRange;
    project?: string | undefined;
    table?: SessionsQuery;
    timeZone: string;
  },
  earlierDays?: ReturnType<typeof readEarlierDays>,
) => {
  // A project's dossier reads the rest of its figures up to `now`, so its table
  // and chart stay at the period's own end to agree with them.
  const period = { ...agentsPeriod({ now, range, timeZone }), project };
  const listed = project === undefined ? sessionsPeriod(period, now) : period;
  const details = readSessionDetails(sql, listed);
  const [{ missedTags, models, sessions }, running, chart, earlier] = await settleAll([
    details,
    readRunningSessions(sql, { now, project }),
    readCostChart(sql, {
      now,
      period: listed,
      range,
      timeZone,
      whole: details.then(({ whole }) => whole),
    }),
    earlierDays ?? (project === undefined ? readEarlierDays(sql, now, timeZone) : []),
  ]);
  const overview: PeriodOverview = {
    breakdown: breakdownTotals(sessions, models),
    chart,
    from: period.from.getTime(),
    now,
    range,
    running,
    sessionCount: sessions.length,
    systemCount: new Set(sessions.map(({ system }) => system)).size,
    table: sessionsPage(sessions, table, now),
    timeZone,
    totals: periodTotals(sessions),
    usualByNow: usualByNow(earlier),
  };
  return { missedTags, overview, period: listed };
};

// Totals and breakdowns use every Session in the period. The table returns
// the page its query asks for. Call it inside readSnapshot, which turns JIT
// off, since the indexed reads finish faster than PostgreSQL can compile them.
export const readPeriodOverview = async (
  sql: SQL,
  input: Parameters<typeof readPeriodDetails>[1],
) => {
  const { overview, period } = await readPeriodDetails(sql, input);
  return { overview, period };
};

type AgentsInput = {
  now: number;
  range: AgentsRange;
  table?: SessionsQuery;
  timeZone: string;
};

const readAgentsFigures = async (sql: SQL, input: AgentsInput) => {
  const { now, range, timeZone } = input;
  const period = sessionsPeriod(agentsPeriod(input), now);
  const [roleSplit, todays, earlier] = await settleAll([
    readRoleSplit(sql, period),
    range === 'today' ? undefined : readPeriodSessions(sql, todaySessionsPeriod(now, timeZone)),
    readEarlierDays(sql, now, timeZone),
  ]);
  return { earlier, roleSplit, todays };
};

// All Agents figures read the same snapshot, on one connection.
const readAgentsSnapshot = async (tx: SQL, input: AgentsInput): Promise<AgentsOverview> => {
  const figures = readAgentsFigures(tx, input);
  const [period, { roleSplit, todays }] = await settleBoth(
    readPeriodDetails(
      tx,
      input,
      figures.then(({ earlier }) => earlier),
    ),
    figures,
  );
  const { missedTags, overview } = period;
  return {
    ...overview,
    missedTags,
    roleSplit,
    today: todays === undefined ? overview.totals : periodTotals(todays.sessions),
  };
};

// Stored totals can lag request pricing until the Hub refreshes them
// (ADR-0016). Every range reads on one connection: at production scale
// (10,000 Sessions) the 30-day read takes about 0.6 s, as a Session wholly
// inside a chart bar reuses the model totals its row already read, and a
// Session crossing an edge reads the stored intervals, by model or by role,
// pricing only the requests in an interval the edge cuts.
export const readAgentsOverview = (sql: SQL, input: AgentsInput) =>
  readSnapshot(sql, false, (tx) => readAgentsSnapshot(tx, input));
