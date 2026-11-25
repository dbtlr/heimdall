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
// period takes its stored split (ADR-0016); one crossing the period's edge
// takes its split over the period, which reuses the stored intervals inside
// it and puts each other request in its conversation's class, as the Hub
// defines it in insight.conversation_roles (ADR-0025), so this read holds no
// copy of that rule.
const readSplitRows = (sql: SQL, { from, project, to }: RoleSplitScope): Promise<SplitRow[]> => sql`
  WITH spans AS MATERIALIZED (${sessionSpans(sql, { from, project, to })})
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
    SELECT x.role_class, x.seat, x.requests, x.priced_cost_usd, x.unpriced_requests
    FROM spans k
    CROSS JOIN LATERAL session_window_role_totals(k.harness, k.system, k.source, k.session_id,
      ${from}, ${to}::timestamptz + interval '1 microsecond') x
    WHERE NOT (k.first_request_at >= ${from} AND k.last_request_at <= ${to})
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
