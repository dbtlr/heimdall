import type { SQL } from 'bun';

import { UNKNOWN_MODEL } from './agents-overview-types.ts';
import type {
  AgentsOverview,
  AgentsRange,
  AgentsSession,
  ModelTotals,
} from './agents-overview-types.ts';
import { projectOf } from './fleet-overview.ts';

type SessionRow = {
  first_cwd: string | null;
  first_git_branch: string | null;
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

// A model's totals per Session in the period: the Hub's stored model totals
// for a Session wholly inside it, and request pricing for one crossing a
// boundary, as for the Session totals. Like them, stored model totals lag a
// change until the Hub's refresh (ADR-0016). The spans repeat the Session
// query's, which the planner reads in about a millisecond.
const readModelRows = (
  sql: SQL,
  { from, to }: { from: Date; to: Date },
): Promise<ModelRow[]> => sql`
  WITH spans AS MATERIALIZED (
    SELECT harness, system, source, session_id,
           min(started_at) AS first_request_at, max(ended_at) AS last_request_at
    FROM insight.session_stretches
    GROUP BY harness, system, source, session_id
    HAVING max(ended_at) >= ${from} AND min(started_at) <= ${to}
  )
  SELECT k.harness, k.system, k.source, k.session_id,
         coalesce(nullif(t.model, ''), ${UNKNOWN_MODEL}) AS model,
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

// The fleet's model totals over the Sessions listed, and each Session's models.
const modelBreakdown = (rows: ModelRow[], sessions: SessionRow[]) => {
  const listed = new Set(sessions.map(sessionIdentity));
  const totals = new Map<string, ModelTotals>();
  const used = new Map<string, Set<string>>();
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
  }
  return { models: [...totals.values()], used };
};

const readSnapshot = async (
  sql: SQL,
  { now, range, timeZone }: { now: number; range: AgentsRange; timeZone: string },
): Promise<AgentsOverview> => {
  const to = new Date(now);
  // startOfDay chooses the first instant of a local day, including repeated
  // or skipped midnight. PostgreSQL's AT TIME ZONE picks a repeated one later.
  const from = new Date(
    range === 'today'
      ? Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).startOfDay()
          .epochMilliseconds
      : now - 86_400_000 * (range === '7d' ? 7 : 30),
  );
  // Stored stretches include subagents. Only Sessions crossing a boundary need
  // request pricing; whole-Session totals retain the Hub's refresh semantics.
  const rows: SessionRow[] = await sql`
    WITH spans AS MATERIALIZED (
      SELECT harness, system, source, session_id,
             min(started_at) AS first_request_at, max(ended_at) AS last_request_at
      FROM insight.session_stretches
      GROUP BY harness, system, source, session_id
      HAVING max(ended_at) >= ${from} AND min(started_at) <= ${to}
    )
    SELECT k.harness, k.system, k.source, k.session_id,
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
    ORDER BY coalesce(t.priced_cost_usd, 0) DESC, k.system, k.harness, k.source, k.session_id
  `;
  const { models, used } = modelBreakdown(await readModelRows(sql, { from, to }), rows);
  const sessions: AgentsSession[] = rows.map((row) => ({
    activeRecently: now - row.last_request_at.getTime() <= 60_000,
    branch: row.last_git_branch ?? row.first_git_branch ?? undefined,
    harness: row.harness,
    lastRequestAt: row.last_request_at.getTime(),
    models: [...(used.get(sessionIdentity(row)) ?? [])].toSorted(),
    pricedCostUsd: row.priced_cost_usd,
    project: projectOf(row.repository, row.last_cwd ?? row.first_cwd),
    requests: row.requests,
    sessionId: row.session_id,
    source: row.source,
    system: row.system,
    unpricedRequests: row.unpriced_requests,
  }));
  return {
    from: from.getTime(),
    models,
    now,
    range,
    sessions,
    timeZone,
    totals: sessions.reduce(
      (totals, session) => ({
        pricedCostUsd: totals.pricedCostUsd + session.pricedCostUsd,
        requests: totals.requests + session.requests,
        unpricedRequests: totals.unpricedRequests + session.unpricedRequests,
      }),
      { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 },
    ),
  };
};

// Read one database snapshot. Stored totals can lag request pricing until the
// Hub refreshes them (ADR-0016); the fleet total sums the displayed amounts.
export const readAgentsOverview = (sql: SQL, input: Parameters<typeof readSnapshot>[1]) =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', (tx) => readSnapshot(tx, input));
