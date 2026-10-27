import { axisTicks } from '../lib/axis.ts';
import { isOverview } from '../lib/fleet-data.ts';
import type { FleetData } from '../lib/fleet-data.ts';
import { clockAt } from '../lib/phrase.ts';
import { rangeLead } from '../lib/range.ts';
import { emptyFleetText } from '../lib/unpaired.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import type { Range } from '../server/fleet-overview-types.ts';
import { PhraseText } from './date-time.tsx';
import { DeliveryFailing } from './delivery-failing.tsx';
import { FleetLane } from './fleet-lane.tsx';
import { FleetLegend } from './fleet-legend.tsx';
import { OpenNow } from './open-now.tsx';
import { RangePicker } from './range-picker.tsx';
import { TimeAxis } from './time-axis.tsx';
import { UnpairedLanes, UnpairedLink } from './unpaired-lanes.tsx';

// The Fleet page from `lg`: what Compare shows, the Systems as lanes on one
// time axis. A phone's browser reads only the glance, and a first load is
// always a glance, so until the overview loads the page header shows over a
// quiet placeholder. What renders depends on the loader data alone.
export function FleetWide({
  data,
  deliveryFailingSince,
  range,
  showUnpaired,
}: {
  data: FleetData;
  deliveryFailingSince: number | undefined;
  range: Range;
  showUnpaired: boolean;
}) {
  const timeZone = useTimeZone();
  // Below the header so the page's h1 comes first at `lg`; the phone's own copy sits in the route.
  const strip = deliveryFailingSince !== undefined && (
    <DeliveryFailing now={data.now} since={deliveryFailingSince} />
  );
  if (!isOverview(data)) {
    return (
      <div className="hidden lg:block">
        <FleetWideHeader range={range} />
        {strip}
        <p className="border-t py-3 text-muted-foreground">Loading lanes…</p>
      </div>
    );
  }
  const { now } = data;
  const empty = emptyFleetText(data.lanes);
  const window = { from: data.from, to: data.to };
  const itemsOf = (system: string) => data.attention.filter((item) => item.system === system);
  return (
    <div className="hidden lg:block">
      <FleetWideHeader range={data.range} to={data.to} />
      {strip}
      {empty !== undefined && <p className="border-t py-3 text-muted-foreground">{empty.text}</p>}
      <div className="[--lane-label:210px]">
        {empty?.replacesLanes !== true &&
          data.lanes.map((lane) => (
            <FleetLane
              items={itemsOf(lane.name)}
              key={lane.name}
              lane={lane}
              now={now}
              window={window}
            />
          ))}
        {showUnpaired && (
          <UnpairedLanes itemsOf={itemsOf} lanes={data.unpairedLanes} now={now} window={window} />
        )}
      </div>
      <UnpairedLink count={data.unpairedCount} shown={showUnpaired} />
      <TimeAxis
        ticks={timeZone === undefined ? [] : axisTicks(data.range, window, timeZone)}
        window={window}
      />
      <OpenNow items={data.attention} now={now} />
    </div>
  );
}

// The title, the range's lead (with its end time once known), the legend, and
// the range picker.
function FleetWideHeader({ range, to }: { range: Range; to?: number }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 pt-5 pb-2.5">
      <h1 className="text-2xl font-semibold">Fleet</h1>
      <p className="text-[22px] font-semibold">
        {rangeLead(range)}
        {to !== undefined && <PhraseText phrase={[', to ', clockAt(to)]} />}
      </p>
      <FleetLegend />
      <RangePicker current={range} />
    </div>
  );
}
