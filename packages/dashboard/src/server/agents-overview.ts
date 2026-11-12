import type { SQL } from 'bun';

import { localDays, RUNNING_MS, usualByNow } from '../lib/home-agents.ts';
import { readCostChart } from './agents-costs.ts';
import type {
  AgentsBreakdown,
  AgentsOverview,
  AgentsRange,
  AgentsSession,
  ModelTotals,
  PeriodTotals,
  SessionSort,
  SessionsPage,
  SessionsQuery,
} from './agents-overview-types.ts';
import { SESSIONS_PER_PAGE } from './agents-overview-types.ts';
import { readDayCosts, USUAL_DAYS } from './day-costs.ts';
import { projectOf } from './fleet-overview.ts';
import { sessionSpans } from './session-spans.ts';

// The period whose requests count, and the earliest latest request that
// selects a Session, `from` unless given: Home's running Sessions are those
// with a recent request, each priced over all of its requests.
export type Period = { from: Date; lastRequestFrom?: Date; to: Date };

type SessionRow = {
  first_cwd: string | null;
  first_git_branch: string | null;
  first_request_at: Date;
  harness: string;
  last_cwd: string | null;
  last_git_branch: string | null;
  last_request_at: Date;
  priced_cost_usd: number;
  repository: string | null;
  requests: number;
  session_id: string;
  source: string;
  system: string;
  unpriced_requests: number;
};

type ModelRow = {
  harness: string;
  model: string;
  priced_cost_usd: number;
  requests: number;
  session_id: string;
  source: string;
  system: string;
  unpriced_requests: number;
};

const sessionIdentity = (row: Pick<SessionRow, 'harness' | 'session_id' | 'source' | 'system'>) =>
  JSON.stringify([row.system, row.harness, row.source, row.session_id]);

// Each Session of the `spans` CTE (see sessionSpans) with what its requests in
// the period cost, as a fragment to nest in a statement that defines `spans`.
// Stored stretches include subagents. Only Sessions crossing a boundary need
// request pricing; whole-Session totals retain the Hub's refresh semantics.
// `span_last_request_at` is the Session's latest request overall; the column
// `last_request_at` is its latest in the period.
const pricedSessions = (sql: SQL, { from, to }: { from: Date; to: Date }) => sql`
  SELECT k.harness, k.system, k.source, k.session_id, k.first_request_at,
         k.last_request_at AS span_last_request_at,
         s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch, s.repository,
         t.requests::float8 AS requests, coalesce(t.priced_cost_usd, 0)::float8 AS priced_cost_usd,
         t.unpriced_requests::float8 AS unpriced_requests, t.last_request_at
  FROM spans k
  CROSS JOIN LATERAL (
    SELECT x.first_cwd, x.last_cwd, x.first_git_branch, x.last_git_branch, x.repository
    FROM insight.sessions x
    WHERE (x.harness, x.system, x.source, x.session_id)
        = (k.harness, k.system, k.source, k.session_id)
    OFFSET 0
  ) s
  CROSS JOIN LATERAL (
    SELECT x.requests, x.priced_cost_usd, x.unpriced_requests, k.last_request_at
    FROM insight.session_totals x
    WHERE (x.harness, x.system, x.source, x.session_id)
        = (k.harness, k.system, k.source, k.session_id)
      AND k.first_request_at >= ${from} AND k.last_request_at <= ${to}
    UNION ALL
    SELECT count(*), sum(r.cost_usd), count(*) FILTER (WHERE r.cost_usd IS NULL), max(r.at)
    FROM insight.requests r
    WHERE (r.harness, r.system, r.source, r.session_id)
        = (k.harness, k.system, k.source, k.session_id)
      AND NOT (k.first_request_at >= ${from} AND k.last_request_at <= ${to})
      AND r.at >= ${from} AND r.at <= ${to}
    HAVING count(*) > 0
  ) t
  WHERE t.requests > 0
`;

const readSessionRows = (
  sql: SQL,
  { from, lastRequestFrom = from, to }: Period,
): Promise<SessionRow[]> => sql`
  WITH spans AS MATERIALIZED (${sessionSpans(sql, { from: lastRequestFrom, to })})
  ${pricedSessions(sql, { from, to })}
  ORDER BY priced_cost_usd DESC, system, harness, source, session_id
`;

// A model's totals per Session in the period: the Hub's stored model totals
// for a Session wholly inside it, and request pricing for one crossing a
// boundary, as for the Session totals. Like them, stored model totals lag a
// change until the Hub's refresh (ADR-0016). The spans are the Session
// query's.
const readModelRows = (
  sql: SQL,
  { from, lastRequestFrom = from, to }: Period,
): Promise<ModelRow[]> => sql`
  WITH spans AS MATERIALIZED (${sessionSpans(sql, { from: lastRequestFrom, to })})
  SELECT k.harness, k.system, k.source, k.session_id,
         t.model,
         t.requests::float8 AS requests, coalesce(t.priced_cost_usd, 0)::float8 AS priced_cost_usd,
         t.unpriced_requests::float8 AS unpriced_requests
  FROM spans k
  CROSS JOIN LATERAL (
    SELECT x.model, x.requests, x.priced_cost_usd, x.unpriced_requests
    FROM insight.session_model_totals x
    WHERE (x.harness, x.system, x.source, x.session_id)
        = (k.harness, k.system, k.source, k.session_id)
      AND k.first_request_at >= ${from} AND k.last_request_at <= ${to}
    UNION ALL
    SELECT r.model, count(*), sum(r.cost_usd), count(*) FILTER (WHERE r.cost_usd IS NULL)
    FROM insight.requests r
    WHERE (r.harness, r.system, r.source, r.session_id)
        = (k.harness, k.system, k.source, k.session_id)
      AND NOT (k.first_request_at >= ${from} AND k.last_request_at <= ${to})
      AND r.at >= ${from} AND r.at <= ${to}
    GROUP BY r.model
  ) t
  WHERE t.requests > 0
`;

// The fleet's model totals over the Sessions listed, each Session's models,
// and the model each made the most requests with, the first in code unit
// order on a tie.
const modelBreakdown = (rows: ModelRow[], sessions: SessionRow[]) => {
  const listed = new Set(sessions.map(sessionIdentity));
  const totals = new Map<string, ModelTotals>();
  const used = new Map<string, Set<string>>();
  const top = new Map<string, { model: string; requests: number }>();
  for (const row of rows.filter((candidate) => listed.has(sessionIdentity(candidate)))) {
    const total = totals.get(row.model) ?? {
      model: row.model,
      pricedCostUsd: 0,
      requests: 0,
      unpricedRequests: 0,
    };
    total.pricedCostUsd += row.priced_cost_usd;
    total.requests += row.requests;
    total.unpricedRequests += row.unpriced_requests;
    totals.set(row.model, total);
    const identity = sessionIdentity(row);
    used.set(identity, (used.get(identity) ?? new Set<string>()).add(row.model));
    const leader = top.get(identity);
    if (
      leader === undefined ||
      row.requests > leader.requests ||
      (row.requests === leader.requests && row.model < leader.model)
    ) {
      top.set(identity, { model: row.model, requests: row.requests });
    }
  }
  return { models: [...totals.values()], top, used };
};

const sortColumn = (sql: SQL, sort: SessionSort) =>
  ({
    cost: sql`priced_cost_usd`,
    duration: sql`(last_request_at - first_request_at)`,
    harness: sql`harness COLLATE "C"`,
    model: sql`models[1] COLLATE "C"`,
    project: sql`project COLLATE "C"`,
    requests: sql`requests`,
    started: sql`first_request_at`,
    system: sql`system COLLATE "C"`,
  })[sort];

// The condition a picked breakdown row puts on the table. A project is named
// as `projectOf` does, from the repository or else the working directory.
const pickFilter = (sql: SQL, by: AgentsBreakdown, pick: string | undefined) => {
  if (pick === undefined) {
    return sql`TRUE`;
  }
  return {
    harness: sql`harness = ${pick}`,
    model: sql`${pick} = ANY(models)`,
    project: sql`coalesce(project, '') = ${pick}`,
    system: sql`system = ${pick}`,
  }[by];
};

type PageRow = SessionRow & { models: string[]; total: number };

// One page of the Sessions with a request in the period that match the query,
// each with what its requests in the period cost, and the count of all that
// match. The filter, sort, page, and count run in the database. A Session
// crossing the period's edge is priced per request, as in readSessionRows,
// and its models by requests in the period come from stored model totals for
// a Session wholly inside it and request pricing otherwise, the first in code
// unit order on a tie. Sessions with a request in the last RUNNING_MS come
// first on every sort. Call it inside a snapshot.
const readSessionPageRows = (
  sql: SQL,
  { from, to }: { from: Date; to: Date },
  { by, dir, page, pick, sort }: SessionsQuery,
): Promise<PageRow[]> => sql`
  WITH spans AS MATERIALIZED (${sessionSpans(sql, { from, to })}),
  priced AS MATERIALIZED (${pricedSessions(sql, { from, to })}),
  used AS (
    SELECT p.harness, p.system, p.source, p.session_id,
           array_agg(m.model ORDER BY m.requests DESC, m.model COLLATE "C") AS models
    FROM priced p
    CROSS JOIN LATERAL (
      SELECT x.model, x.requests
      FROM insight.session_model_totals x
      WHERE (x.harness, x.system, x.source, x.session_id)
          = (p.harness, p.system, p.source, p.session_id)
        AND p.first_request_at >= ${from} AND p.span_last_request_at <= ${to}
      UNION ALL
      SELECT r.model, count(*)
      FROM insight.requests r
      WHERE (r.harness, r.system, r.source, r.session_id)
          = (p.harness, p.system, p.source, p.session_id)
        AND NOT (p.first_request_at >= ${from} AND p.span_last_request_at <= ${to})
        AND r.at >= ${from} AND r.at <= ${to}
      GROUP BY r.model
    ) m
    GROUP BY p.harness, p.system, p.source, p.session_id
  ),
  listed AS (
    SELECT p.*, coalesce(u.models, '{}') AS models,
           coalesce(
             (regexp_match(p.repository, '([^/]+)/*$'))[1],
             (regexp_match(coalesce(p.last_cwd, p.first_cwd), '([^/]+)/*$'))[1]
           ) AS project
    FROM priced p
    LEFT JOIN used u
      ON (u.harness, u.system, u.source, u.session_id)
       = (p.harness, p.system, p.source, p.session_id)
  )
  SELECT *, count(*) OVER ()::float8 AS total
  FROM listed
  WHERE ${pickFilter(sql, by, pick)}
  ORDER BY last_request_at >= ${new Date(to.getTime() - RUNNING_MS)} DESC,
           ${sortColumn(sql, sort)} ${dir === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST,
           system, harness, source, session_id
  LIMIT ${SESSIONS_PER_PAGE} OFFSET ${(page - 1) * SESSIONS_PER_PAGE}
`;

const toSession = (row: PageRow): AgentsSession => ({
  branch: row.last_git_branch ?? row.first_git_branch ?? undefined,
  firstRequestAt: row.first_request_at.getTime(),
  harness: row.harness,
  lastRequestAt: row.last_request_at.getTime(),
  models: row.models.toSorted(),
  pricedCostUsd: row.priced_cost_usd,
  project: projectOf(row.repository, row.last_cwd ?? row.first_cwd),
  requests: row.requests,
  sessionId: row.session_id,
  source: row.source,
  system: row.system,
  topModel: row.models[0],
  unpricedRequests: row.unpriced_requests,
});

// The page asked for of the Sessions table. A page past the last one reads as
// the first, so a link to a page that no longer exists still shows Sessions.
export const readSessionPage = async (
  sql: SQL,
  period: { from: Date; to: Date },
  query: SessionsQuery,
): Promise<SessionsPage> => {
  let rows = await readSessionPageRows(sql, period, query);
  let page = query.page;
  if (rows.length === 0 && page > 1) {
    page = 1;
    rows = await readSessionPageRows(sql, period, { ...query, page });
  }
  return { page, sessions: rows.map(toSession), total: rows[0]?.total ?? 0 };
};

// The Sessions with a request in the period, most expensive first, each with
// what its requests in the period cost, and the fleet's model totals over
// them. Two statements, however many Sessions there are. Call it inside a
// snapshot.
export const readPeriodSessions = async (
  sql: SQL,
  period: Period,
): Promise<{ models: ModelTotals[]; sessions: AgentsSession[] }> => {
  const rows = await readSessionRows(sql, period);
  const { models, top, used } = modelBreakdown(await readModelRows(sql, period), rows);
  const sessions = rows.map((row) => ({
    branch: row.last_git_branch ?? row.first_git_branch ?? undefined,
    firstRequestAt: row.first_request_at.getTime(),
    harness: row.harness,
    lastRequestAt: row.last_request_at.getTime(),
    models: [...(used.get(sessionIdentity(row)) ?? [])].toSorted(),
    pricedCostUsd: row.priced_cost_usd,
    project: projectOf(row.repository, row.last_cwd ?? row.first_cwd),
    requests: row.requests,
    sessionId: row.session_id,
    source: row.source,
    system: row.system,
    topModel: top.get(sessionIdentity(row))?.model,
    unpricedRequests: row.unpriced_requests,
  }));
  return { models, sessions };
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

const DEFAULT_SESSIONS_QUERY: SessionsQuery = {
  by: 'project',
  dir: 'desc',
  page: 1,
  pick: undefined,
  sort: 'started',
};

const readSnapshot = async (
  sql: SQL,
  {
    now,
    range,
    table = {},
    timeZone,
  }: { now: number; range: AgentsRange; table?: Partial<SessionsQuery>; timeZone: string },
): Promise<AgentsOverview> => {
  const period =
    range === 'today'
      ? todayPeriod(now, timeZone)
      : { from: new Date(now - 86_400_000 * (range === '7d' ? 7 : 30)), to: new Date(now) };
  const [{ models, sessions }, page, chart, todays, earlier] = await Promise.all([
    readPeriodSessions(sql, period),
    readSessionPage(sql, period, { ...DEFAULT_SESSIONS_QUERY, ...table }),
    readCostChart(sql, { now, period, range, timeZone }),
    // The period's own Sessions are today's when the period is Today.
    range === 'today' ? undefined : readPeriodSessions(sql, todayPeriod(now, timeZone)),
    readDayCosts(sql, localDays(now, timeZone, USUAL_DAYS + 1).slice(0, -1)),
  ]);
  const totals = periodTotals(sessions);
  return {
    chart,
    from: period.from.getTime(),
    models,
    now,
    range,
    sessions,
    table: page,
    timeZone,
    today: todays === undefined ? totals : periodTotals(todays.sessions),
    totals,
    usualByNow: usualByNow(earlier),
  };
};

// Read one database snapshot. Stored totals can lag request pricing until the
// Hub refreshes them (ADR-0016); the fleet total sums the displayed amounts.
export const readAgentsOverview = (sql: SQL, input: Parameters<typeof readSnapshot>[1]) =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', (tx) => readSnapshot(tx, input));
