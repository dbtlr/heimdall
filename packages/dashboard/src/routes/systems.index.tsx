import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { FleetTiles } from '../components/fleet-tiles.tsx';
import { UnpairedLink } from '../components/unpaired-link.tsx';
import { tileOrder } from '../lib/fleet-tile.ts';
import { contentFrame } from '../lib/layout.ts';
import { emptyFleetText, unpairedFromSearch } from '../lib/unpaired.ts';
import { getSystemTiles } from '../server/home-fn.ts';

export const Route = createFileRoute('/systems/')({
  component: Systems,
  loader: ({ deps }: { deps: { unpaired: boolean } }) => getSystemTiles({ data: deps }),
  loaderDeps: ({ search }) => ({ unpaired: search.unpaired === true }),
  // `unpaired` is true or absent, as on Home, so a URL without it lists the paired Systems.
  validateSearch: (search: { unpaired?: unknown } & SearchSchemaInput) => ({
    unpaired: unpairedFromSearch(search) || undefined,
  }),
});

// Every paired System as the tile Home shows, with its status, its last day of
// CPU, its newest Vitals, and its Services up, each opening its page;
// `?unpaired` adds the unpaired Systems below, as on Home.
function Systems() {
  const glance = Route.useLoaderData();
  const showUnpaired = Route.useSearch().unpaired === true;
  const { now } = glance;
  const empty = emptyFleetText(glance.lanes);
  return (
    <main className={`${contentFrame('wide')} pb-8`}>
      <div className="flex items-baseline justify-between gap-3 pt-5 pb-4 sm:pt-6">
        <h1 className="text-[24px] font-semibold sm:text-[28px]">Systems</h1>
        <p className="text-sm text-muted-foreground">
          {glance.lanes.length} paired {glance.lanes.length === 1 ? 'System' : 'Systems'}
        </p>
      </div>
      {empty !== undefined && <p className="pb-3 text-lg font-semibold">{empty.text}</p>}
      <FleetTiles
        from={glance.from}
        now={now}
        tiles={tileOrder(glance.lanes, glance.attention, now)}
      />
      {showUnpaired && (
        <section className="mt-6">
          <h2 className="mb-3 text-lg font-semibold">Unpaired, history kept</h2>
          {glance.unpairedLanes.length === 0 ? (
            <p>No System is unpaired.</p>
          ) : (
            <FleetTiles
              from={glance.from}
              now={now}
              tiles={tileOrder(glance.unpairedLanes, glance.attention, now)}
            />
          )}
        </section>
      )}
      {glance.unpairedCount > 0 && (
        <div className="mt-4">
          <UnpairedLink count={glance.unpairedCount} shown={showUnpaired} />
        </div>
      )}
    </main>
  );
}
