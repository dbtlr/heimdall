import type { TimelineEntry } from './system-detail-types.ts';

export type FleetTimeline = {
  entries: (TimelineEntry & { paired: boolean; system: string })[];
  now: number;
};
