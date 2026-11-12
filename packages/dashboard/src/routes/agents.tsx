import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect } from 'react';

import { AgentsChart } from '../components/agents-chart.tsx';
import { AgentsFigures, rangeName } from '../components/agents-headline.tsx';
import { AgentsRangePicker } from '../components/agents-range-picker.tsx';
import { AgentsSessions } from '../components/agents-sessions.tsx';
import { breakdownRows, sessionsIn } from '../lib/agents-breakdown.ts';
import { agentsSearch } from '../lib/agents-search.ts';
import { contentFrame } from '../lib/layout.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { getAgentsOverview } from '../server/agents-overview-fn.ts';
import type { AgentsRange } from '../server/agents-overview-types.ts';

export const Route = createFileRoute('/agents')({
  component: Agents,
  loader: ({ deps }: { deps: { range: AgentsRange; zone: string | undefined } }) =>
    deps.zone === undefined
      ? undefined
      : getAgentsOverview({ data: { range: deps.range, timeZone: deps.zone } }),
  loaderDeps: ({ search }) => ({ range: search.range, zone: search.zone }),
  validateSearch: (
    search: { by?: unknown; pick?: unknown; range?: unknown; zone?: unknown } & SearchSchemaInput,
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
  const systems = ready ? new Set(overview.sessions.map((session) => session.system)).size : 0;
  return (
    <main className={`${contentFrame('wide')} pb-8`}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 pt-5 pb-4 sm:pt-6">
        <div>
          <h1 className="text-[24px] font-semibold sm:text-[28px]">Agents</h1>
          {ready && (
            <p className="text-sm text-muted-foreground">
              List price · {overview.sessions.length}{' '}
              {overview.sessions.length === 1 ? 'Session' : 'Sessions'} on {systems}{' '}
              {systems === 1 ? 'System' : 'Systems'}{' '}
              {overview.range === 'today' ? 'today' : `in ${rangeName(overview.range)}`}
            </p>
          )}
        </div>
        {ready && <AgentsFigures overview={overview} />}
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
              now={overview.now}
              picked={picked?.name}
              sessions={
                picked === undefined
                  ? overview.sessions
                  : sessionsIn(overview.sessions, search.by, picked.key)
              }
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
