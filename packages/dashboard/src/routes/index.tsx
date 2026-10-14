import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { DateTime } from '../components/date-time.tsx';
import { FleetLane } from '../components/fleet-lane.tsx';
import { FleetLegend } from '../components/fleet-legend.tsx';
import { OpenConditions } from '../components/open-conditions.tsx';
import { RangePicker } from '../components/range-picker.tsx';
import { TimeAxis } from '../components/time-axis.tsx';
import { UnpairedLanes, UnpairedLink } from '../components/unpaired-lanes.tsx';
import { axisTicks } from '../lib/axis.ts';
import { rangeFromSearch, rangeLead } from '../lib/range.ts';
import { emptyFleetText, unpairedFromSearch } from '../lib/unpaired.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
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
  const timeZone = useTimeZone();
  const { now, range } = overview;
  const empty = emptyFleetText(overview.lanes);
  const window = { from: overview.from, to: overview.to };
  return (
    <>
      <AppHeader>
        <RangePicker current={range} />
      </AppHeader>
      <main className="mx-auto max-w-[1200px] px-3.5 pb-8 sm:px-[22px]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 pt-3.5 pb-2 sm:pt-[18px] sm:pb-2.5">
          <h1 className="text-[19px] font-semibold sm:text-[22px]">
            {rangeLead(range)} <DateTime at={overview.to} format="clock" />
          </h1>
          <FleetLegend />
        </div>
        {empty !== undefined && <p className="border-t py-3 text-muted-foreground">{empty.text}</p>}
        {empty?.replacesLanes !== true &&
          overview.lanes.map((lane) => (
            <FleetLane key={lane.name} lane={lane} now={now} window={window} />
          ))}
        {showUnpaired && <UnpairedLanes lanes={overview.unpairedLanes} now={now} window={window} />}
        <UnpairedLink count={overview.unpairedCount} shown={showUnpaired} />
        <TimeAxis
          ticks={timeZone === undefined ? [] : axisTicks(range, window, timeZone)}
          window={window}
        />
        <OpenConditions now={now} open={overview.open} />
      </main>
    </>
  );
}
