import type { FleetGlance, FleetOverview } from '../server/fleet-overview-types.ts';

// What the Fleet page's loader returns: the light glance, or, in a browser at
// `lg` or wider, the overview with each System's history for the lanes.
export type FleetData = FleetGlance | FleetOverview;

// Whether the loader read the overview. Only an overview carries a range.
export const isOverview = (data: FleetData): data is FleetOverview => 'range' in data;
