import type { SQL } from 'bun';

import { roleClassOf } from '../lib/cost-roles.ts';
import type { CostClass } from '../lib/cost-roles.ts';
import type { PeriodTotals } from './agents-overview-types.ts';
import type { RoleSplit, SeatTotals } from './role-split-types.ts';
import { sessionSpans } from './session-spans.ts';

// The period whose requests count, and which Sessions: a project's, or, with
// none, every Session with a request in the period.
export type RoleSplitScope = {
  from: Date;
  project?: string | undefined;
  to: Date;
};

type SplitRow = {
  priced_cost_usd: number;
  requests: number;
  role_class: string;
  seat: string | null;
  unpriced_requests: number;
};

// The period's cost by role class and seat, in one statement however many
// Sessions there are. As for the Session totals, a Session wholly inside the
// period takes its stored split (ADR-0016); one crossing the period's edge has
// its requests inside the period grouped by conversation and each group put in
// its conversation's class, as the Hub's own split does (ADR-0025): the main
// conversation's, the subagent's, or for a subagent the Hub does not hold, the
// main conversation's role read as a subagent's.
const readSplitRows = (sql: SQL, { from, project, to }: RoleSplitScope): Promise<SplitRow[]> => sql`
  WITH spans AS MATERIALIZED (${sessionSpans(sql, { from, project, to })}),
  -- Each crossing Session's subagents, read once per Session by its key: the
  -- Hub walks a Session's subagents to find their effective roles. OFFSET 0
  -- keeps the read per Session rather than over every Session's subagents.
  crossing_subagents AS MATERIALIZED (
    SELECT a.harness, a.system, a.source, a.session_id, a.agent_id, a.role_class, a.effective_seat
    FROM spans k
    CROSS JOIN LATERAL (
      SELECT * FROM insight.subagents a
      WHERE (a.harness, a.system, a.source, a.session_id)
          = (k.harness, k.system, k.source, k.session_id)
      OFFSET 0
    ) a
    WHERE NOT (k.first_request_at >= ${from} AND k.last_request_at <= ${to})
  ),
  -- Each crossing Session's requests inside the period, by conversation.
  crossing_groups AS (
    SELECT k.harness, k.system, k.source, k.session_id, g.agent_id, g.requests,
           g.priced_cost_usd, g.unpriced_requests
    FROM spans k
    CROSS JOIN LATERAL (
      SELECT r.agent_id, count(*) AS requests, sum(r.cost_usd) AS priced_cost_usd,
             count(*) FILTER (WHERE r.cost_usd IS NULL) AS unpriced_requests
      FROM insight.requests r
      WHERE (r.harness, r.system, r.source, r.session_id)
          = (k.harness, k.system, k.source, k.session_id)
        AND r.at >= ${from} AND r.at <= ${to}
      GROUP BY r.agent_id
    ) g
    WHERE NOT (k.first_request_at >= ${from} AND k.last_request_at <= ${to})
  )
  SELECT t.role_class, t.seat,
         sum(t.requests)::float8 AS requests,
         coalesce(sum(t.priced_cost_usd), 0)::float8 AS priced_cost_usd,
         sum(t.unpriced_requests)::float8 AS unpriced_requests
  FROM (
    SELECT x.role_class, x.seat, x.requests, x.priced_cost_usd, x.unpriced_requests
    FROM spans k
    JOIN insight.session_role_totals x USING (harness, system, source, session_id)
    -- Only a visible Session, so the classes sum to the headline's total.
    JOIN insight.sessions s USING (harness, system, source, session_id)
    WHERE k.first_request_at >= ${from} AND k.last_request_at <= ${to}
    UNION ALL
    -- Joined to the subagents outside any per-Session read, so the planner
    -- hashes them once instead of scanning them for every group.
    SELECT CASE WHEN g.agent_id IS NULL THEN s.role_class
                WHEN a.agent_id IS NOT NULL THEN a.role_class
                WHEN s.effective_role = 'review' THEN 'review' ELSE 'delegated' END,
           CASE WHEN a.agent_id IS NOT NULL THEN a.effective_seat ELSE s.effective_seat END,
           g.requests, g.priced_cost_usd, g.unpriced_requests
    FROM crossing_groups g
    CROSS JOIN LATERAL (
      SELECT s.role_class, s.effective_role, s.effective_seat FROM insight.sessions s
      WHERE (s.harness, s.system, s.source, s.session_id)
          = (g.harness, g.system, g.source, g.session_id)
      OFFSET 0
    ) s
    LEFT JOIN crossing_subagents a
      ON (a.harness, a.system, a.source, a.session_id, a.agent_id)
       = (g.harness, g.system, g.source, g.session_id, g.agent_id)
  ) t
  GROUP BY t.role_class, t.seat
`;

const totalsOf = (row: SplitRow): PeriodTotals => ({
  pricedCostUsd: row.priced_cost_usd,
  requests: row.requests,
  unpricedRequests: row.unpriced_requests,
});

const add = (a: PeriodTotals, b: PeriodTotals): PeriodTotals => ({
  pricedCostUsd: a.pricedCostUsd + b.pricedCostUsd,
  requests: a.requests + b.requests,
  unpricedRequests: a.unpricedRequests + b.unpricedRequests,
});

const NO_COST: PeriodTotals = { pricedCostUsd: 0, requests: 0, unpricedRequests: 0 };

// The split of the rows read: each class's sum, and the review class's seats.
const splitOf = (rows: readonly SplitRow[]): RoleSplit => {
  const classes: Record<CostClass, PeriodTotals> = {
    delegated: NO_COST,
    main: NO_COST,
    review: NO_COST,
  };
  const seats: SeatTotals[] = [];
  for (const row of rows) {
    const roleClass = roleClassOf(row.role_class);
    classes[roleClass] = add(classes[roleClass], totalsOf(row));
    if (roleClass === 'review') {
      seats.push({ seat: row.seat, ...totalsOf(row) });
    }
  }
  return { classes, seats };
};

// The scope's list-price cost by role class and review seat, counting the
// same Sessions and requests as the Agents page's totals, so the classes sum
// to them. Call it inside a snapshot with JIT off: compiling the split's
// lateral reads costs more than running them.
export const readRoleSplit = async (sql: SQL, scope: RoleSplitScope): Promise<RoleSplit> =>
  splitOf(await readSplitRows(sql, scope));
