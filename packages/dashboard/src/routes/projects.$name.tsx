import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect } from 'react';

import { AgentsRangePicker } from '../components/agents-range-picker.tsx';
import { ProjectDossier } from '../components/project-dossier.tsx';
import { agentsSearch, sessionsQueryOf } from '../lib/agents-search.ts';
import { contentFrame } from '../lib/layout.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import type { AgentsRange, SessionsQuery } from '../server/agents-overview-types.ts';
import { getProjectView } from '../server/project-view-fn.ts';

type ProjectDeps = { query: SessionsQuery; range: AgentsRange; zone: string | undefined };

export const Route = createFileRoute('/projects/$name')({
  component: ProjectPage,
  loader: ({ params, deps }: { params: { name: string }; deps: ProjectDeps }) =>
    getProjectView({
      data: { ...deps.query, name: params.name, range: deps.range, timeZone: deps.zone ?? 'UTC' },
    }),
  loaderDeps: ({ search }) => ({
    query: sessionsQueryOf(search),
    range: search.range,
    zone: search.zone,
  }),
  notFoundComponent: () => (
    <main className={`${contentFrame('wide')} py-6`}>
      <p>The Hub holds no such project.</p>
    </main>
  ),
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) =>
    agentsSearch({ ...search, by: search.by ?? 'harness', range: search.range ?? '30d' }),
});

function ProjectPage() {
  const view = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const zone = useTimeZone();
  useEffect(() => {
    if (zone !== undefined && search.zone !== zone) {
      void navigate({
        replace: true,
        resetScroll: false,
        search: (previous) => ({ ...previous, zone }),
      });
    }
  }, [navigate, search.zone, zone]);
  return (
    <main className={`${contentFrame('wide')} space-y-5 py-5 sm:py-6`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{view.name}</h1>
        <AgentsRangePicker current={search.range} />
      </div>
      {zone === undefined || view.overview.timeZone !== zone ? (
        <p className="py-5 text-muted-foreground" role="status">
          Loading requests in your time zone…
        </p>
      ) : (
        <ProjectDossier view={view} query={sessionsQueryOf(search)} />
      )}
    </main>
  );
}
