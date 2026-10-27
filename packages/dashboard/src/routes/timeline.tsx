import { createFileRoute, Link } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { ActiveTimelineFilters, TimelineFilterControl } from '../components/timeline-filters.tsx';
import { ConditionOccurrence } from '../components/timeline-rail.tsx';
import { TimelineTable } from '../components/timeline-table.tsx';
import { contentFrame } from '../lib/layout.ts';
import { filterTimeline, timelineSearch } from '../lib/timeline-filters.ts';
import type { TimelineFilters } from '../lib/timeline-filters.ts';
import { getFleetTimeline } from '../server/fleet-timeline-fn.ts';

export const Route = createFileRoute('/timeline')({
  component: FleetTimeline,
  loader: () => getFleetTimeline(),
  validateSearch: (
    search: { level?: unknown; status?: unknown; system?: unknown } & SearchSchemaInput,
  ) => timelineSearch(search),
});

function FleetTimeline() {
  const { entries: all, now } = Route.useLoaderData();
  const search = Route.useSearch();
  const filters = {
    level: search.level ?? [],
    status: search.status ?? [],
    system: search.system ?? [],
  };
  const navigate = Route.useNavigate();
  const entries = filterTimeline(all, filters);
  const filtered = filters.level.length + filters.status.length + filters.system.length > 0;
  const change = (next: TimelineFilters) => {
    void navigate({
      resetScroll: false,
      search: {
        level: (next.level.length > 0 && next.level) || undefined,
        status: (next.status.length > 0 && next.status) || undefined,
        system: (next.system.length > 0 && next.system) || undefined,
      },
    });
  };
  return (
    <>
      <AppHeader />
      <main className={`${contentFrame('wide')} py-5`}>
        <header className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Timeline</h1>
            <p className="mt-1 mb-5 text-base text-muted-foreground">
              Across all Systems, last 7 days and still open. Newest occurrence first.
            </p>
            {filtered && (
              <p aria-live="polite" className="mb-5 text-sm text-muted-foreground">
                {entries.length} of {all.length} {all.length === 1 ? 'occurrence' : 'occurrences'}
              </p>
            )}
          </div>
          {all.length > 0 && (
            <TimelineFilterControl entries={all} filters={filters} onChange={change} />
          )}
        </header>
        <ActiveTimelineFilters entries={all} filters={filters} onChange={change} />
        {entries.length === 0 ? (
          <p>
            {all.length === 0
              ? 'No Condition in the last 7 days.'
              : 'No occurrence matches these filters.'}
          </p>
        ) : (
          <>
            <div className="hidden lg:block">
              <TimelineTable entries={entries} now={now} />
            </div>
            <ol className="max-w-3xl space-y-3 lg:hidden">
              {entries.map((entry) => (
                <li className="rounded-xl border bg-card p-4" key={entry.id}>
                  <Link
                    className="flex min-h-11 min-w-0 flex-wrap items-center gap-2 text-lg font-semibold text-primary"
                    params={{ name: entry.system }}
                    search={{ tab: 'timeline' }}
                    to="/systems/$name"
                  >
                    <span className="break-all">{entry.system}</span>
                    {!entry.paired && (
                      <span className="text-sm text-muted-foreground">Unpaired · history kept</span>
                    )}
                  </Link>
                  <ol>
                    <ConditionOccurrence entry={entry} now={now} system={entry.system} />
                  </ol>
                </li>
              ))}
            </ol>
          </>
        )}
      </main>
    </>
  );
}
