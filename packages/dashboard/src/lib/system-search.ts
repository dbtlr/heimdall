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
