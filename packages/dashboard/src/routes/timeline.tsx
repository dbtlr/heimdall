import { createFileRoute, Link } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { ConditionOccurrence } from '../components/timeline-rail.tsx';
import { contentFrame } from '../lib/layout.ts';
import { getFleetTimeline } from '../server/fleet-timeline-fn.ts';

export const Route = createFileRoute('/timeline')({
  component: FleetTimeline,
  loader: () => getFleetTimeline(),
});

function FleetTimeline() {
  const { entries, now } = Route.useLoaderData();
  return (
    <>
      <AppHeader />
      <main className={`${contentFrame('wide')} py-5`}>
        <h1 className="text-2xl font-semibold">Timeline</h1>
        <p className="mt-1 mb-5 text-base text-muted-foreground">
          Across all Systems, last 7 days and still open. Newest occurrence first.
        </p>
        {entries.length === 0 ? (
          <p>No Condition in the last 7 days.</p>
        ) : (
          <ol className="max-w-3xl space-y-3">
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
        )}
      </main>
    </>
  );
}
