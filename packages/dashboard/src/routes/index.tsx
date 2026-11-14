import { Link, createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect } from 'react';

import { FleetTiles } from '../components/fleet-tiles.tsx';
import { AgentsCard } from '../components/home-agents.tsx';
import { ChangesCard, JobsCard, MaintenanceCardView } from '../components/home-cards.tsx';
import { HomeVerdictCard } from '../components/home-verdict.tsx';
import { NeedsAttention } from '../components/needs-attention.tsx';
import { UnpairedLink } from '../components/unpaired-lanes.tsx';
import { validZone } from '../lib/agents-search.ts';
import { tileOrder } from '../lib/fleet-tile.ts';
import { maintenanceCard } from '../lib/home-maintenance.ts';
import { homeFigures, homeVerdict } from '../lib/home.ts';
import { contentFrame } from '../lib/layout.ts';
import { unpairedFromSearch } from '../lib/unpaired.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { getHome } from '../server/home-fn.ts';

export const Route = createFileRoute('/')({
  component: Home,
  loader: ({ deps }: { deps: { unpaired: boolean; zone: string | undefined } }) =>
    getHome({ data: { timeZone: deps.zone, unpaired: deps.unpaired } }),
  loaderDeps: ({ search }) => ({ unpaired: search.unpaired === true, zone: search.zone }),
  // `unpaired` is true or absent. `zone` is the viewer's time zone, which the
  // page adds once the browser tells it, as the Agents page does; agent work
  // is counted in it. Home has no range, so an older link that names one
  // opens Home as it is.
  validateSearch: (search: { unpaired?: unknown; zone?: unknown } & SearchSchemaInput) => ({
    unpaired: unpairedFromSearch(search) || undefined,
    zone: validZone(search.zone),
  }),
});

// Home, the same on every screen and stacked on a phone: the verdict, what
// needs attention beside agent work, a tile per paired System, then the
// maintenance that can wait, what changed, and the jobs, and the ways on to
// Compare and the unpaired Systems.
function Home() {
  const home = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const timeZone = useTimeZone();
  useEffect(() => {
    if (timeZone !== undefined && search.zone !== timeZone) {
      void navigate({
        replace: true,
        resetScroll: false,
        search: (previous) => ({ ...previous, zone: timeZone }),
      });
    }
  }, [navigate, search.zone, timeZone]);
  const showUnpaired = search.unpaired === true;
  const { now } = home;
  // Agent work read in another zone than the browser's waits for its own.
  const agents = home.agents?.timeZone === timeZone ? home.agents : undefined;
  const running = agents?.running ?? [];
  const tiles = tileOrder(home.lanes, home.attention, now);
  return (
    <main className={`${contentFrame('wide')} pb-8`}>
      <h1 className="sr-only">Home</h1>
      <div className="flex flex-col gap-3 pt-3 sm:gap-3.5 sm:pt-3.5">
        <HomeVerdictCard
          agents={
            agents === undefined ? undefined : { running: running.length, today: agents.today }
          }
          figures={homeFigures(home.lanes, now)}
          verdict={homeVerdict(home)}
        />
        <div className="grid items-start gap-3 sm:gap-3.5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <NeedsAttention
            attention={home.attention}
            lastCleared={home.lastCleared}
            lead={home.lead}
            now={now}
          />
          <AgentsCard agents={agents} now={now} />
        </div>
        <section aria-label="Systems">
          <FleetTiles from={home.from} now={now} running={running} tiles={tiles} />
        </section>
        <div className="grid items-start gap-3 sm:gap-3.5 lg:grid-cols-3">
          <MaintenanceCardView
            card={maintenanceCard(
              {
                attention: home.attention,
                packages: home.maintenance.packages,
                updates: home.maintenance.updates,
              },
              now,
            )}
          />
          <ChangesCard changes={home.changes} now={now} />
          <JobsCard jobs={home.jobs} now={now} />
        </div>
      </div>
      <Link
        className="mt-2 inline-flex min-h-11 items-center text-base text-primary underline underline-offset-4"
        to="/activity"
      >
        Activity on one time axis →
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
              running={running}
              tiles={tileOrder(home.unpairedLanes, home.attention, now)}
            />
          )}
        </section>
      )}
      <UnpairedLink count={home.unpairedCount} shown={showUnpaired} />
    </main>
  );
}
