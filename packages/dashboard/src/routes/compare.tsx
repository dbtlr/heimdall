import { Link, createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { PhraseText } from '../components/date-time.tsx';
import { FleetLane } from '../components/fleet-lane.tsx';
import { FleetLegend } from '../components/fleet-legend.tsx';
import { OpenNow } from '../components/open-now.tsx';
import { RangePicker } from '../components/range-picker.tsx';
import { TimeAxis } from '../components/time-axis.tsx';
import { UnpairedLanes, UnpairedLink } from '../components/unpaired-lanes.tsx';
import { axisTicks } from '../lib/axis.ts';
import { contentFrame } from '../lib/layout.ts';
import { clockAt } from '../lib/phrase.ts';
import { rangeFromSearch, rangeLead } from '../lib/range.ts';
import { emptyFleetText, unpairedFromSearch } from '../lib/unpaired.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { getFleetOverview } from '../server/fleet-overview-fn.ts';
import type { Range } from '../server/fleet-overview-types.ts';

export const Route = createFileRoute('/compare')({
  component: Compare,
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

function Compare() {
  const overview = Route.useLoaderData();
  const showUnpaired = Route.useSearch().unpaired === true;
  const timeZone = useTimeZone();
  const { now, range } = overview;
  const empty = emptyFleetText(overview.lanes);
  const window = { from: overview.from, to: overview.to };
  const itemsOf = (system: string) => overview.attention.filter((item) => item.system === system);
  return (
    <>
      <AppHeader>
        <RangePicker current={range} />
      </AppHeader>
      <main className={`${contentFrame('wide')} pb-8`}>
        <Link className="inline-flex min-h-11 items-center text-primary" to="/">
          ‹ Fleet
        </Link>
        <h1 className="text-2xl font-semibold">Compare</h1>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 pt-3.5 pb-2 sm:pt-[18px] sm:pb-2.5">
          <h2 className="text-[19px] font-semibold sm:text-[22px]">
            {rangeLead(range)}
            <PhraseText phrase={[', to ', clockAt(overview.to)]} />
          </h2>
          <FleetLegend />
        </div>
        {empty !== undefined && <p className="border-t py-3 text-muted-foreground">{empty.text}</p>}
        <div className="[--lane-label:210px]">
          {empty?.replacesLanes !== true &&
            overview.lanes.map((lane) => (
              <FleetLane
                items={itemsOf(lane.name)}
                key={lane.name}
                lane={lane}
                now={now}
                window={window}
              />
            ))}
          {showUnpaired && (
            <UnpairedLanes
              itemsOf={itemsOf}
              lanes={overview.unpairedLanes}
              now={now}
              window={window}
            />
          )}
        </div>
        <UnpairedLink count={overview.unpairedCount} shown={showUnpaired} />
        <TimeAxis
          ticks={timeZone === undefined ? [] : axisTicks(range, window, timeZone)}
          window={window}
        />
        <OpenNow items={overview.attention} now={now} />
      </main>
    </>
  );
}
