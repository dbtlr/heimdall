import { Link, createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { CanWait } from '../components/can-wait.tsx';
import { DeliveryFailing } from '../components/delivery-failing.tsx';
import { FleetTiles } from '../components/fleet-tiles.tsx';
import { FleetVerdict } from '../components/fleet-verdict.tsx';
import { OpenNow } from '../components/open-now.tsx';
import { UnpairedLink } from '../components/unpaired-lanes.tsx';
import { canWaitRows, tileOrder } from '../lib/fleet-tile.ts';
import { deliveryFailingShown, fleetAttention } from '../lib/fleet.ts';
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
  const { counts } = fleetAttention(overview.attention);
  const deliveryFailingSince = deliveryFailingShown(overview);
  const tiles = tileOrder(overview.lanes, overview.attention, now);
  return (
    <>
      <AppHeader inline={overview.lanes.length > 0 && <FleetVerdict counts={counts} />} />
      <main className="mx-auto max-w-[1200px] px-3.5 pb-8 sm:px-[22px]">
        <h1 className="sr-only">Fleet</h1>
        {deliveryFailingSince !== undefined && (
          <DeliveryFailing now={now} since={deliveryFailingSince} />
        )}
        {empty !== undefined && <p className="pt-4 text-lg font-semibold">{empty.text}</p>}
        <div className="pt-3">
          <FleetTiles now={now} tiles={tiles} />
        </div>
        <CanWait
          rows={canWaitRows(
            tiles.map(({ lane }) => lane.name),
            overview.attention,
          )}
        />
        <Link
          className="mt-2 inline-flex min-h-11 items-center text-base text-primary underline underline-offset-4"
          search={{ range, unpaired: showUnpaired || undefined }}
          to="/compare"
        >
          Compare on one time axis →
        </Link>
        {showUnpaired && (
          <section className="mt-4">
            <h2 className="mb-3 text-lg font-semibold">Unpaired, history kept</h2>
            {overview.unpairedLanes.length === 0 ? (
              <p>No System is unpaired.</p>
            ) : (
              <FleetTiles
                now={now}
                tiles={tileOrder(overview.unpairedLanes, overview.attention, now)}
              />
            )}
            <OpenNow items={overview.attention.filter((item) => item.unpaired)} now={now} />
          </section>
        )}
        <UnpairedLink count={overview.unpairedCount} shown={showUnpaired} />
      </main>
    </>
  );
}
