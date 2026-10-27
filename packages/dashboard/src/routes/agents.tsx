import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect } from 'react';

import { AgentsRangePicker } from '../components/agents-range-picker.tsx';
import { AgentsSessions } from '../components/agents-sessions.tsx';
import { AgentsSummary } from '../components/agents-summary.tsx';
import { AppHeader } from '../components/app-header.tsx';
import { DateTime } from '../components/date-time.tsx';
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
  const recent = ready
    ? overview.sessions.filter((session) => session.activeRecently).length
    : undefined;
  // A pick that matches no row is ignored.
  const picked = ready
    ? breakdownRows(overview, search.by).find((row) => row.key === search.pick)
    : undefined;
  return (
    <>
      <AppHeader>
        <AgentsRangePicker current={search.range} />
      </AppHeader>
      <main className={`${contentFrame('wide')} pb-8`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pt-5 pb-4 sm:pt-6">
          <h1 className="text-[24px] font-semibold sm:text-[28px]">Agents</h1>
          {recent !== undefined && (
            <p
              className="text-sm text-muted-foreground"
              title="Sessions with a request observed in the last 60 seconds"
            >
              {recent} active recently
            </p>
          )}
        </div>
        {!ready ? (
          <p className="py-5 text-muted-foreground" role="status">
            Loading requests in your time zone…
          </p>
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <div>
              <p className="mb-3 text-sm text-muted-foreground">
                {overview.range === 'today'
                  ? 'Requests since local midnight'
                  : `Requests in the last ${overview.range === '7d' ? '7' : '30'} days`}
                , to <DateTime at={overview.now} format="clock" />.
              </p>
              <AgentsSummary by={search.by} overview={overview} pick={picked?.key} />
              <p className="mt-3 text-sm text-muted-foreground">
                Token usage at API list prices, including subagents. Subscription charges may
                differ.
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Session amounts include only requests in this period.
              </p>
            </div>
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
          </div>
        )}
      </main>
    </>
  );
}
