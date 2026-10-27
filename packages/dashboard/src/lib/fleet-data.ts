import type { FleetGlance, FleetOverview, Range } from '../server/fleet-overview-types.ts';

// What the Fleet page's loader returns: the light glance, or, in a browser at
// `lg` or wider, the overview with each System's history for the lanes.
export type FleetData = FleetGlance | FleetOverview;

// Whether the loader read the overview. Only an overview carries a range.
export const isOverview = (data: FleetData): data is FleetOverview => 'range' in data;

// The loader's choice: a browser at `lg` or wider reads the overview for the
// lanes, anything narrower reads only the glance. The width answer and the two
// readers are parameters so the choice stands apart from the server functions.
export function readFleetPage(
  { range, unpaired }: { range: Range; unpaired: boolean },
  readers: {
    wide: boolean;
    overview: (args: { data: { range: Range; unpaired: boolean } }) => Promise<FleetOverview>;
    glance: (args: { data: { unpaired: boolean } }) => Promise<FleetGlance>;
  },
): Promise<FleetData> {
  return readers.wide
    ? readers.overview({ data: { range, unpaired } })
    : readers.glance({ data: { unpaired } });
}
