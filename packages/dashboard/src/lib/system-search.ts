import { atFromSearch, rangeFromSearch } from './range.ts';

export const SYSTEM_TABS = ['now', 'vitals', 'sessions', 'records', 'timeline'] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number];

// Existing sample links predate tabs and should still show the selected sample.
export const systemSearch = (search: Record<string, unknown>) => {
  const at = atFromSearch(search);
  return {
    at,
    range: rangeFromSearch(search, '12h'),
    tab: SYSTEM_TABS.find((tab) => tab === search.tab) ?? (at === undefined ? 'now' : 'vitals'),
  };
};
