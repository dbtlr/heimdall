import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect } from 'react';

import { AgentsChart } from '../components/agents-chart.tsx';
import { AgentsFigures, rangeName } from '../components/agents-headline.tsx';
import { AgentsRangePicker } from '../components/agents-range-picker.tsx';
import { AgentsSessions } from '../components/agents-sessions.tsx';
import { breakdownRows, nameOf } from '../lib/agents-breakdown.ts';
import { agentsSearch, sessionsQueryOf } from '../lib/agents-search.ts';
import { contentFrame } from '../lib/layout.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { getAgentsOverview } from '../server/agents-overview-fn.ts';
import type { AgentsRange, SessionsQuery } from '../server/agents-overview-types.ts';

type AgentsDeps = { query: SessionsQuery; range: AgentsRange; zone: string | undefined };

export const Route = createFileRoute('/agents')({
  component: Agents,
  loader: ({ deps: { query, range, zone } }: { deps: AgentsDeps }) =>
    zone === undefined
      ? undefined
      : getAgentsOverview({ data: { ...query, range, timeZone: zone } }),
  // The Sessions table is read with the period, in one snapshot, so a sort or
  // a page reads the page asked for rather than filtering a list in the browser.
  loaderDeps: ({ search }) => ({
    query: sessionsQueryOf(search),
    range: search.range,
    zone: search.zone,
  }),
  validateSearch: (
    search: {
      by?: unknown;
      dir?: unknown;
      page?: unknown;
      pick?: unknown;
      range?: unknown;
      sort?: unknown;
      zone?: unknown;
    } & SearchSchemaInput,
  ) => agentsSearch(search),
});

function Agents() {
  const overview = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const timeZone = useTimeZone();
  useEffect(() => {
    if (timeZone !== undefined && search.zone !== timeZone) {
      void navigate({
        replace: true,
        resetScroll: false,
        search: (previous) => ({ ...previous, zone: timeZone }),
      });
    }
  }, [navigate, search.zone, timeZone]);
  const ready = timeZone !== undefined && overview?.timeZone === timeZone;
  // A pick that matches no key is ignored.
  const picked = ready
    ? breakdownRows(overview, search.by).find((row) => row.key === search.pick)
    : undefined;
  const order = sessionsQueryOf(search);
  return (
    <main className={`${contentFrame('wide')} pb-8`}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 pt-5 pb-4 sm:pt-6">
        <div>
          <h1 className="text-[24px] font-semibold sm:text-[28px]">Agents</h1>
          {ready && (
            <p className="hidden text-sm text-muted-foreground sm:block">
              List price · {overview.sessionCount}{' '}
              {overview.sessionCount === 1 ? 'Session' : 'Sessions'} on {overview.systemCount}{' '}
              {overview.systemCount === 1 ? 'System' : 'Systems'}{' '}
              {overview.range === 'today' ? 'today' : `in ${rangeName(overview.range)}`}
            </p>
          )}
        </div>
        {/* On a phone the range picker shares the title's row and the figures wrap under both. */}
        {ready && (
          <div className="order-last w-full sm:order-none sm:w-auto">
            <AgentsFigures overview={overview} />
          </div>
        )}
        <AgentsRangePicker current={search.range} />
      </div>
      {!ready ? (
        <p className="py-5 text-muted-foreground" role="status">
          Loading requests in your time zone…
        </p>
      ) : (
        <div className="space-y-6">
          <AgentsChart by={search.by} overview={overview} pick={picked?.key} />
          <div>
            <AgentsSessions
              by={search.by}
              dir={order.dir}
              now={overview.now}
              pick={
                search.pick === undefined
                  ? undefined
                  : (picked?.name ?? nameOf(search.by, search.pick))
              }
              rangeText={overview.range === 'today' ? 'today' : `in ${rangeName(overview.range)}`}
              sort={order.sort}
              table={overview.table}
              timeZone={overview.timeZone}
            />
            <p className="mt-3 text-sm text-muted-foreground">
              Token usage at API list prices, including subagents. Subscription charges may differ.
              Session amounts include only requests in this period.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
