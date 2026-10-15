import { Link, createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { MARK_COLOR } from '../components/attention-status.tsx';
import { FleetAttention } from '../components/fleet-attention.tsx';
import { FleetSystems } from '../components/fleet-systems.tsx';
import { OpenNow } from '../components/open-now.tsx';
import { UnpairedLink } from '../components/unpaired-lanes.tsx';
import { fleetAttention, fleetVerdict, isAsleep, levelCountsText } from '../lib/fleet.ts';
import { rangeFromSearch } from '../lib/range.ts';
import { emptyFleetText, unpairedFromSearch } from '../lib/unpaired.ts';
import { cn } from '../lib/utils.ts';
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
  const asleep = overview.lanes.filter((lane) => isAsleep(lane, now));
  const window = { from: overview.from, to: overview.to };
  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[1200px] px-3.5 pb-8 sm:px-[22px]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 pt-3.5 pb-2 sm:pt-[18px] sm:pb-2.5">
          <p className="text-lg font-semibold">Fleet</p>
          <Link
            className="inline-flex min-h-11 items-center text-base text-primary underline underline-offset-4"
            search={{ range, unpaired: showUnpaired || undefined }}
            to="/compare"
          >
            Compare on one time axis →
          </Link>
        </div>
        <section className="border-b pt-2 pb-4">
          <h1
            className={cn(
              'text-3xl leading-tight font-semibold wrap-anywhere',
              counts.alert > 0 ? MARK_COLOR.alert : counts.warning > 0 && MARK_COLOR.warning,
            )}
          >
            {counts.alert + counts.warning > 0
              ? fleetVerdict(overview.attention)
              : (empty?.text ?? fleetVerdict(overview.attention))}
          </h1>
          {overview.lanes.length > 0 && (
            <p className="mt-2 text-base text-muted-foreground">
              {levelCountsText(counts) || 'No open Conditions'} across {overview.lanes.length}{' '}
              System{overview.lanes.length === 1 ? '' : 's'}.{' '}
              {asleep.length > 0 &&
                `${asleep.map((lane) => lane.name).join(', ')} ${asleep.length === 1 ? 'is' : 'are'} asleep.`}
            </p>
          )}
        </section>
        <FleetAttention items={overview.attention} now={now} />
        <h2 className="py-3 text-lg font-semibold">Systems</h2>
        <FleetSystems
          attention={overview.attention}
          lanes={overview.lanes}
          now={now}
          range={range}
          window={window}
        />
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
                range={range}
                window={window}
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
