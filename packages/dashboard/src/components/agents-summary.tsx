import { breakdownRows } from '../lib/agents-breakdown.ts';
import { formatCost } from '../lib/time.ts';
import type { AgentsBreakdown, AgentsOverview } from '../server/agents-overview-types.ts';
import { AgentsBreakdownList, AgentsBreakdownSwitch } from './agents-breakdown.tsx';

export function AgentsSummary({
  by,
  overview,
  pick,
}: {
  by: AgentsBreakdown;
  overview: AgentsOverview;
  pick: string | undefined;
}) {
  const systems = new Set(overview.sessions.map((session) => session.system)).size;
  const { totals } = overview;
  return (
    <section aria-label="Period list-price cost" className="rounded-2xl border bg-card p-4 sm:p-6">
      <p className="text-sm text-muted-foreground">List-price cost</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-[44px] leading-tight font-bold tracking-tight sm:text-[56px]">
          {formatCost(totals.pricedCostUsd)}
        </p>
        {totals.unpricedRequests > 0 && (
          <span className="rounded-md border border-[#4b3f78] px-2 text-sm font-semibold text-[#c9b6ff]">
            At least
          </span>
        )}
      </div>
      <p className="mt-2 text-muted-foreground">
        {overview.sessions.length} {overview.sessions.length === 1 ? 'Session' : 'Sessions'} on{' '}
        {systems} {systems === 1 ? 'System' : 'Systems'}.
        {totals.unpricedRequests > 0 && (
          <>
            {' '}
            {totals.unpricedRequests}{' '}
            {totals.unpricedRequests === 1 ? 'request has' : 'requests have'} no list price.
          </>
        )}
      </p>
      <AgentsBreakdownSwitch current={by} />
      <AgentsBreakdownList by={by} pick={pick} rows={breakdownRows(overview, by)} />
    </section>
  );
}
