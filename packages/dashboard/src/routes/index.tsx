import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';

import { AppHeader } from '../components/app-header.tsx';
import { FleetLane } from '../components/fleet-lane.tsx';
import { FleetLegend } from '../components/fleet-legend.tsx';
import { OpenConditions } from '../components/open-conditions.tsx';
import { RangePicker } from '../components/range-picker.tsx';
import { TimeAxis } from '../components/time-axis.tsx';
import { rangeFromSearch, rangeTitle } from '../lib/range.ts';
import { getFleetOverview } from '../server/fleet-overview-fn.ts';
import type { Range } from '../server/fleet-overview-types.ts';

export const Route = createFileRoute('/')({
  component: Fleet,
  // Annotated, because Router infers `deps` only from a `loaderDeps` written first, which key order forbids.
  loader: ({ deps }: { deps: { range: Range } }) =>
    getFleetOverview({ data: { range: deps.range } }),
  loaderDeps: ({ search }) => ({ range: search.range }),
  validateSearch: (search: { range?: unknown } & SearchSchemaInput) => ({
    range: rangeFromSearch(search),
  }),
});

function Fleet() {
  const overview = Route.useLoaderData();
  const { now, range, timeZone } = overview;
  const window = { from: overview.from, to: overview.to };
  return (
    <>
      <AppHeader>
        <RangePicker current={range} />
      </AppHeader>
      <main className="mx-auto max-w-[1200px] px-3.5 pb-8 sm:px-[22px]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 pt-3.5 pb-2 sm:pt-[18px] sm:pb-2.5">
          <h1 className="text-[19px] font-semibold sm:text-[22px]">
            {rangeTitle(range, overview.to, timeZone)}
          </h1>
          <FleetLegend />
        </div>
        {overview.lanes.length === 0 ? (
          <p className="border-t py-3 text-muted-foreground">No System is paired.</p>
        ) : (
          overview.lanes.map((lane) => (
            <FleetLane key={lane.name} lane={lane} now={now} timeZone={timeZone} window={window} />
          ))
        )}
        <TimeAxis range={range} timeZone={timeZone} window={window} />
        <OpenConditions now={now} open={overview.open} timeZone={timeZone} />
      </main>
    </>
  );
}
