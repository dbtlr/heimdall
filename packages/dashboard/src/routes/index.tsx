import { Link, createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { CanWait } from '../components/can-wait.tsx';
import { FleetTiles } from '../components/fleet-tiles.tsx';
import { HomeVerdictCard } from '../components/home-verdict.tsx';
import { NeedsAttention } from '../components/needs-attention.tsx';
import { UnpairedLink } from '../components/unpaired-lanes.tsx';
import { canWaitRows, tileOrder } from '../lib/fleet-tile.ts';
import { homeFigures, homeVerdict } from '../lib/home.ts';
import { contentFrame } from '../lib/layout.ts';
import { unpairedFromSearch } from '../lib/unpaired.ts';
import { getHome } from '../server/home-fn.ts';

export const Route = createFileRoute('/')({
  component: Home,
  loader: ({ deps }: { deps: { unpaired: boolean } }) => getHome({ data: deps }),
  loaderDeps: ({ search }) => ({ unpaired: search.unpaired === true }),
  // `unpaired` is true or absent. Home has no range, so an older link that
  // names one opens Home as it is.
  validateSearch: (search: { unpaired?: unknown } & SearchSchemaInput) => ({
    unpaired: unpairedFromSearch(search) || undefined,
  }),
});

// Home, the same on every screen and stacked on a phone: the verdict, what
// needs attention, a tile per paired System, the notes that can wait, and the
// ways on to Compare and the unpaired Systems.
function Home() {
  const home = Route.useLoaderData();
  const showUnpaired = Route.useSearch().unpaired === true;
  const { now } = home;
  const tiles = tileOrder(home.lanes, home.attention, now);
  return (
    <main className={`${contentFrame('wide')} pb-8`}>
      <h1 className="sr-only">Home</h1>
      <div className="flex flex-col gap-3 pt-3 sm:gap-3.5 sm:pt-3.5">
        <HomeVerdictCard figures={homeFigures(home.lanes, now)} verdict={homeVerdict(home)} />
        <NeedsAttention
          attention={home.attention}
          lastCleared={home.lastCleared}
          lead={home.lead}
          now={now}
        />
        <section aria-label="Systems">
          <FleetTiles from={home.from} now={now} tiles={tiles} />
        </section>
      </div>
      <CanWait
        rows={canWaitRows(
          tiles.map(({ lane }) => lane.name),
          home.attention,
        )}
      />
      <Link
        className="mt-2 inline-flex min-h-11 items-center text-base text-primary underline underline-offset-4"
        search={{ unpaired: showUnpaired || undefined }}
        to="/compare"
      >
        Compare on one time axis →
      </Link>
      {showUnpaired && (
        <section className="mt-4">
          <h2 className="mb-3 text-lg font-semibold">Unpaired, history kept</h2>
          {home.unpairedLanes.length === 0 ? (
            <p>No System is unpaired.</p>
          ) : (
            <FleetTiles
              from={home.from}
              now={now}
              tiles={tileOrder(home.unpairedLanes, home.attention, now)}
            />
          )}
        </section>
      )}
      <UnpairedLink count={home.unpairedCount} shown={showUnpaired} />
    </main>
  );
}
