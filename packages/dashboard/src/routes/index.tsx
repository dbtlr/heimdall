import { Link, createFileRoute, useRouter } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect } from 'react';

import { AppHeader } from '../components/app-header.tsx';
import { CanWait } from '../components/can-wait.tsx';
import { DeliveryFailing } from '../components/delivery-failing.tsx';
import { FleetTiles } from '../components/fleet-tiles.tsx';
import { FleetVerdict } from '../components/fleet-verdict.tsx';
import { FleetWide } from '../components/fleet-wide.tsx';
import { OpenNow } from '../components/open-now.tsx';
import { UnpairedLink } from '../components/unpaired-lanes.tsx';
import { isOverview } from '../lib/fleet-data.ts';
import type { FleetData } from '../lib/fleet-data.ts';
import { canWaitRows, tileOrder } from '../lib/fleet-tile.ts';
import { deliveryFailingShown, fleetAttention } from '../lib/fleet.ts';
import { contentFrame, isWideBrowser } from '../lib/layout.ts';
import { rangeFromSearch } from '../lib/range.ts';
import { emptyFleetText, unpairedFromSearch } from '../lib/unpaired.ts';
import { getFleetGlance, getFleetOverview } from '../server/fleet-overview-fn.ts';
import type { Range } from '../server/fleet-overview-types.ts';

export const Route = createFileRoute('/')({
  component: Fleet,
  // A phone reads only the light glance. A browser at `lg` or wider reads the
  // overview for the lanes; the server cannot tell, so a first load is a glance.
  // Annotated, because Router infers `deps` only from a `loaderDeps` written first, which key order forbids.
  loader: ({ deps }: { deps: { range: Range; unpaired: boolean } }): Promise<FleetData> =>
    isWideBrowser()
      ? getFleetOverview({ data: deps })
      : getFleetGlance({ data: { unpaired: deps.unpaired } }),
  loaderDeps: ({ search }) => ({ range: search.range, unpaired: search.unpaired === true }),
  // `unpaired` is true or absent, so a URL without it is the plain overview.
  validateSearch: (search: { range?: unknown; unpaired?: unknown } & SearchSchemaInput) => ({
    range: rangeFromSearch(search),
    unpaired: unpairedFromSearch(search) || undefined,
  }),
});

function Fleet() {
  const overview = Route.useLoaderData();
  const search = Route.useSearch();
  const router = useRouter();
  const showUnpaired = search.unpaired === true;
  const { range } = search;
  const { now } = overview;
  const empty = emptyFleetText(overview.lanes);
  const { counts } = fleetAttention(overview.attention);
  const deliveryFailingSince = deliveryFailingShown(overview);
  const tiles = tileOrder(overview.lanes, overview.attention, now);
  const loadedGlance = !isOverview(overview);
  // The first load is a glance. At `lg` the lanes need the overview, so read it
  // once hydrated rather than wait for the next refresh.
  useEffect(() => {
    if (loadedGlance && isWideBrowser()) {
      void router.invalidate();
    }
  }, [loadedGlance, router]);
  return (
    <>
      <AppHeader inline={empty === undefined ? <FleetVerdict counts={counts} /> : undefined} />
      <main className={`${contentFrame('wide')} pb-8`}>
        <h1 className="sr-only lg:hidden">Fleet</h1>
        {deliveryFailingSince !== undefined && (
          <DeliveryFailing now={now} since={deliveryFailingSince} />
        )}
        <div className="lg:hidden">
          {empty !== undefined && <p className="pt-4 text-lg font-semibold">{empty.text}</p>}
          <h2 className="sr-only">Systems</h2>
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
        </div>
        <FleetWide data={overview} range={range} showUnpaired={showUnpaired} />
      </main>
    </>
  );
}
