import { Link, createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { FleetSystems } from '../components/fleet-systems.tsx';
import { OpenNow } from '../components/open-now.tsx';
import { UnpairedLink } from '../components/unpaired-lanes.tsx';
import { rangeFromSearch } from '../lib/range.ts';
import { emptyFleetText, unpairedFromSearch } from '../lib/unpaired.ts';
import { getFleetOverview } from '../server/fleet-overview-fn.ts';
import type { Range } from '../server/fleet-overview-types.ts';

export const Route = createFileRoute('/')({
  component: Fleet,
  // Annotated, because Router infers `deps` only from a `loaderDeps` written first, which key order forbids.
  loader: ({ deps }: { deps: { range: Range; unpaired: boolean } }) =>
    getFleetOverview({ data: deps }),
  loaderDeps: ({ search }) => ({ range: search.range, unpaired: search.unpaired === true }),
  // `unpaired` is true or absent, so a URL without it is the plain overview.
  validateSearch: (search: { range?: unknown; unpaired?: unknown } & SearchSchemaInput) => ({
    range: rangeFromSearch(search),
    unpaired: unpairedFromSearch(search) || undefined,
  }),
});

function Fleet() {
  const overview = Route.useLoaderData();
  const showUnpaired = Route.useSearch().unpaired === true;
  const { now, range } = overview;
  const empty = emptyFleetText(overview.lanes);
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[1200px] px-3.5 pb-8 sm:px-[22px]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 pt-3.5 pb-2 sm:pt-[18px] sm:pb-2.5">
          <h1 className="text-2xl font-semibold">Fleet</h1>
          <Link
            className="inline-flex min-h-11 items-center text-base text-primary underline underline-offset-4"
            search={{ range, unpaired: showUnpaired || undefined }}
            to="/compare"
          >
            Compare on one time axis →
          </Link>
        </div>
        {empty !== undefined && <p className="border-t py-3 text-muted-foreground">{empty.text}</p>}
        <h2 className="py-3 text-lg font-semibold">Systems</h2>
        <FleetSystems attention={overview.attention} lanes={overview.lanes} now={now} />
        {showUnpaired && (
          <section className="mt-4">
            <h2 className="mb-3 text-lg font-semibold">Unpaired, history kept</h2>
            {overview.unpairedLanes.length === 0 ? (
              <p>No System is unpaired.</p>
            ) : (
              <FleetSystems
                attention={overview.attention}
                lanes={overview.unpairedLanes}
                now={now}
              />
            )}
          </section>
        )}
        <UnpairedLink count={overview.unpairedCount} shown={showUnpaired} />
        <OpenNow items={overview.attention} now={now} />
      </main>
    </>
  );
}
