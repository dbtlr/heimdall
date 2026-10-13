import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useMemo } from 'react';

import { AppHeader } from '../components/app-header.tsx';
import { SessionCost } from '../components/session-cost.tsx';
import { SessionHeader } from '../components/session-header.tsx';
import { SessionTabs } from '../components/session-tabs.tsx';
import { SessionTimeline } from '../components/session-timeline.tsx';
import { SessionTrace } from '../components/session-trace.tsx';
import { sessionSearch } from '../lib/session-search.ts';
import type { SessionSearch } from '../lib/session-search.ts';
import { agentLanes } from '../lib/session.ts';
import { getSessionView } from '../server/session-view-fn.ts';

export const Route = createFileRoute('/systems/$name_/sessions/$harness/$source/$sessionId')({
  component: SessionPage,
  loader: async ({
    params,
  }: {
    params: { harness: string; name: string; sessionId: string; source: string };
  }) => ({
    now: Date.now(),
    view: await getSessionView({
      data: {
        harness: params.harness,
        sessionId: params.sessionId,
        source: params.source,
        system: params.name,
      },
    }),
  }),
  notFoundComponent: () => (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[1200px] px-3.5 py-6 sm:px-[22px]">
        <p>The Hub holds no such Session.</p>
      </main>
    </>
  ),
  // The defaults stay out of the URL, so a plain link opens the Timeline.
  search: { middlewares: [stripSearchParams({ filter: 'everything', tab: 'timeline' })] },
  validateSearch: (search: Partial<SessionSearch> & SearchSchemaInput) => sessionSearch(search),
});

function SessionPage() {
  const { now, view } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const lanes = useMemo(() => agentLanes(view), [view]);
  // Moves within the page: the tab, selection, and Trace narrowing, kept in
  // the URL so a link or reload opens the same view.
  const go = (next: Partial<SessionSearch>) => {
    void navigate({
      replace: next.tab === undefined,
      resetScroll: next.tab !== undefined,
      search: (previous: SessionSearch) => ({ ...previous, ...next }),
    });
  };
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[1200px] px-3.5 pb-8 sm:px-[22px]">
        <SessionHeader lanes={lanes} now={now} view={view} />
        <SessionTabs current={search.tab} />
        {search.tab === 'timeline' && (
          <SessionTimeline go={go} lanes={lanes} search={search} view={view} />
        )}
        {search.tab === 'cost' && <SessionCost go={go} lanes={lanes} view={view} />}
        {search.tab === 'trace' && (
          <SessionTrace go={go} lanes={lanes} search={search} view={view} />
        )}
      </main>
    </>
  );
}
