import { harnessColor, harnessName } from '../lib/lane.ts';
import { formatCost } from '../lib/time.ts';
import type { AgentsOverview, PeriodTotals } from '../server/agents-overview-types.ts';

const byHarness = (sessions: AgentsOverview['sessions']) => {
  const totals = new Map<string, PeriodTotals>();
  for (const session of sessions) {
    const total = totals.get(session.harness) ?? {
      pricedCostUsd: 0,
      requests: 0,
      unpricedRequests: 0,
    };
    total.pricedCostUsd += session.pricedCostUsd;
    total.requests += session.requests;
    total.unpricedRequests += session.unpricedRequests;
    totals.set(session.harness, total);
  }
  return [...totals].toSorted(([, left], [, right]) => right.pricedCostUsd - left.pricedCostUsd);
};

export function AgentsSummary({ overview }: { overview: AgentsOverview }) {
  const harnesses = byHarness(overview.sessions);
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
      <div
        aria-label="Priced request cost by Harness"
        className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-accent"
        role="img"
      >
        {harnesses.map(([harness, total]) => (
          <span
            key={harness}
            style={{
              background: harnessColor(harness),
              width: `${String(totals.pricedCostUsd === 0 ? 0 : (total.pricedCostUsd / totals.pricedCostUsd) * 100)}%`,
            }}
          />
        ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap justify-between gap-x-6 gap-y-2 text-sm">
        {harnesses.map(([harness, total]) => (
          <li className="flex items-baseline gap-2" key={harness}>
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: harnessColor(harness) }}
            />
            <span className="text-muted-foreground">{harnessName(harness)}</span>
            <b className="font-semibold">
              {total.unpricedRequests > 0 ? 'At least ' : ''}
              {formatCost(total.pricedCostUsd)}
            </b>
          </li>
        ))}
      </ul>
    </section>
  );
}
