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
// its conversation's class, which the Hub defines in insight.conversation_roles
// (ADR-0025), so this read holds no copy of that rule.
const readSplitRows = (sql: SQL, { from, project, to }: RoleSplitScope): Promise<SplitRow[]> => sql`
  WITH spans AS MATERIALIZED (${sessionSpans(sql, { from, project, to })}),
  -- Each crossing Session's conversations, read once per Session by its key.
  -- OFFSET 0 keeps the read per Session rather than over every Session's.
  crossing_roles AS MATERIALIZED (
    SELECT a.harness, a.system, a.source, a.session_id, a.agent_id, a.role_class, a.seat
    FROM spans k
    CROSS JOIN LATERAL (
      SELECT * FROM insight.conversation_roles a
      WHERE (a.harness, a.system, a.source, a.session_id)
          = (k.harness, k.system, k.source, k.session_id)
      OFFSET 0
    ) a
    WHERE NOT (k.first_request_at >= ${from} AND k.last_request_at <= ${to})
  ),
  -- Each crossing Session's requests inside the period, by conversation.
  -- MATERIALIZED, so the pricing lateral runs once per Session: inlined, the
  -- planner can drive it from crossing_roles below and run it once per
  -- conversation.
  crossing_groups AS MATERIALIZED (
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
    -- Joined to the conversations outside any per-Session read. The main
    -- conversation has no agent id, so the join compares it as a flag.
    SELECT a.role_class, a.seat, g.requests, g.priced_cost_usd, g.unpriced_requests
    FROM crossing_groups g
    JOIN crossing_roles a
      ON (a.harness, a.system, a.source, a.session_id)
       = (g.harness, g.system, g.source, g.session_id)
     AND (a.agent_id IS NULL) = (g.agent_id IS NULL)
     AND coalesce(a.agent_id, '') = coalesce(g.agent_id, '')
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
