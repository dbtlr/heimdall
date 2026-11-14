import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { ActivityRangePicker, KindChips, SystemSelect } from '../components/activity-filters.tsx';
import { ActivityList } from '../components/activity-list.tsx';
import { activityCounts, activitySearch, filterActivity, groupActivity } from '../lib/activity.ts';
import { contentFrame } from '../lib/layout.ts';
import { getActivity } from '../server/activity-fn.ts';
import type { ActivityRange } from '../server/activity-types.ts';

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
  // Annotated, because Router infers `deps` only from a `loaderDeps` written first, which key order forbids.
  loader: ({ deps }: { deps: { range: ActivityRange } }) => getActivity({ data: deps }),
  loaderDeps: ({ search }) => ({ range: search.range }),
  validateSearch: (
    search: { kind?: unknown; range?: unknown; system?: unknown } & SearchSchemaInput,
  ) => activitySearch(search),
});

function ActivityPage() {
  const { events, now, range, unpaired } = Route.useLoaderData();
  const { kind, system } = Route.useSearch();
  const navigate = Route.useNavigate();
  const filters = { kind, system };
  const shown = filterActivity(events, filters);
  const lines = groupActivity(shown);
  const counts = activityCounts(events, filters);
  const unpairedSystems = new Set(unpaired);
  return (
    <main className={`${contentFrame('wide')} py-5`}>
      <header>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="mt-1 text-base text-muted-foreground">
          What changed across the fleet, newest first. Changes on one System within 2 minutes share
          a line.
        </p>
      </header>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <KindChips
          counts={counts.kind}
          current={kind}
          total={Object.values(counts.kind).reduce((sum, count) => sum + count, 0)}
        />
        <SystemSelect
          counts={counts.system}
          current={system}
          onChange={(next) => {
            void navigate({
              resetScroll: false,
              search: (previous) => ({ ...previous, system: next }),
            });
          }}
          unpaired={unpairedSystems}
        />
        <div className="sm:ml-auto">
          <ActivityRangePicker current={range} />
        </div>
      </div>
      <section aria-label="Changes" className="card-surface mt-4 rounded-xl border px-4 py-4">
        {lines.length === 0 ? (
          <p aria-live="polite" className="text-muted-foreground">
            {events.length === 0
              ? 'Nothing changed in this range.'
              : 'No change matches these filters.'}
          </p>
        ) : (
          <ActivityList lines={lines} now={now} unpaired={unpairedSystems} />
        )}
      </section>
    </main>
  );
}
