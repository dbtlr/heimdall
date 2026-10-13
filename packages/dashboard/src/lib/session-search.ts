// The Session page's search parameters: the open tab, the request selected
// across tabs, and how the Trace is narrowed.

import type { TraceFilter } from './session.ts';

export const TABS = ['timeline', 'cost', 'trace'] as const;
export type Tab = (typeof TABS)[number];

const FILTERS: readonly TraceFilter[] = ['everything', 'main', 'subagents', 'tools'];

// The main conversation's key where an agent id is asked for.
export const MAIN = 'main';

export type SessionSearch = {
  // The agent the Trace lists alone: an agent id, or MAIN.
  agent: string | undefined;
  filter: TraceFilter;
  // The lane the Timeline points out, by agent id.
  lane: string | undefined;
  request: string | undefined;
  tab: Tab;
};

const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

// Reads the search, dropping anything it does not know: the page opens on
// the Timeline, with the whole Trace.
export const sessionSearch = (search: Record<string, unknown>): SessionSearch => ({
  agent: text(search.agent),
  filter: FILTERS.find((filter) => filter === search.filter) ?? 'everything',
  lane: text(search.lane),
  request: text(search.request),
  tab: TABS.find((tab) => tab === search.tab) ?? 'timeline',
});
