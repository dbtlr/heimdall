import { RANGE_MS, RANGES } from '../server/fleet-overview-types.ts';
import type { Range } from '../server/fleet-overview-types.ts';
import { atFromSearch, rangeFromSearch } from './range.ts';

export const SYSTEM_TABS = ['now', 'vitals', 'sessions', 'records', 'activity'] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number];

// Existing sample links predate tabs and should still show the selected sample.
// The Activity tab was once called Timeline, and links to it still open it.
export const systemSearch = (search: Record<string, unknown>) => {
  const at = atFromSearch(search);
  const named = search.tab === 'timeline' ? 'activity' : search.tab;
  return {
    at,
    range: rangeFromSearch(search, '12h'),
    tab: SYSTEM_TABS.find((tab) => tab === named) ?? (at === undefined ? 'now' : 'vitals'),
  };
};

// The shortest System page range that ends at `now` and still holds `at`, so a
// link to a sample opens on charts that show it; 7 d for anything older.
export const rangeHolding = (at: number, now: number): Range =>
  RANGES.find((range) => now - at <= RANGE_MS[range]) ?? '7d';

// From `lg` the page has one Overview where the phone has Now, Vitals, and
// Sessions; `tab` is the phone tab a link to each opens.
export const DESKTOP_TABS = [
  { name: 'Overview', tab: 'now' },
  { name: 'Records', tab: 'records' },
  { name: 'Activity', tab: 'activity' },
] as const satisfies readonly { name: string; tab: SystemTab }[];

export type DesktopTab = 'overview' | 'records' | 'activity';

export const desktopTab = (tab: SystemTab): DesktopTab =>
  tab === 'records' || tab === 'activity' ? tab : 'overview';
