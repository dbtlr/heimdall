import { knownValues, stringList } from './filter-search.ts';

export const TIMELINE_LEVELS = ['alert', 'warning', 'note'] as const;
export type TimelineLevel = (typeof TIMELINE_LEVELS)[number];
export const TIMELINE_STATUSES = ['open', 'cleared'] as const;
export type TimelineStatus = (typeof TIMELINE_STATUSES)[number];

export type TimelineFilters = {
  level: TimelineLevel[];
  status: TimelineStatus[];
  system: string[];
};
export const emptyTimelineFilters = (): TimelineFilters => ({ level: [], status: [], system: [] });

type Filterable = { clearedAt: number | undefined; level: TimelineLevel; system: string };
type Section = keyof TimelineFilters;

export const timelineSearch = (search: { level?: unknown; status?: unknown; system?: unknown }) => {
  const system = stringList(search.system);
  return {
    level: knownValues(search.level, TIMELINE_LEVELS),
    status: knownValues(search.status, TIMELINE_STATUSES),
    system: system.length > 0 ? system : undefined,
  };
};

const statusOf = (entry: Filterable): TimelineStatus =>
  entry.clearedAt === undefined ? 'open' : 'cleared';

const valueOf = (entry: Filterable, section: Section): string =>
  section === 'status' ? statusOf(entry) : entry[section];

// An empty selection means every value; `skip` leaves one section out.
const matches = (entry: Filterable, filters: TimelineFilters, skip?: Section) =>
  (['level', 'status', 'system'] as const).every(
    (section) =>
      section === skip ||
      filters[section].length === 0 ||
      filters[section].some((value) => value === valueOf(entry, section)),
  );

// Entries matching every section, in the order given.
export const filterTimeline = <T extends Filterable>(
  entries: readonly T[],
  filters: TimelineFilters,
): T[] => entries.filter((entry) => matches(entry, filters));

// Each chip counts the entries it would show, constrained by the other sections only.
export const timelineFilterCounts = (entries: readonly Filterable[], filters: TimelineFilters) => {
  const counts = {
    level: { alert: 0, note: 0, warning: 0 } as Record<TimelineLevel, number>,
    status: { cleared: 0, open: 0 } as Record<TimelineStatus, number>,
    system: Object.fromEntries([
      ...entries.map((entry) => [entry.system, 0]),
      ...filters.system.map((system) => [system, 0]),
    ]),
  };
  for (const entry of entries) {
    if (matches(entry, filters, 'level')) {
      counts.level[entry.level] += 1;
    }
    if (matches(entry, filters, 'status')) {
      counts.status[statusOf(entry)] += 1;
    }
    if (matches(entry, filters, 'system')) {
      counts.system[entry.system] = (counts.system[entry.system] ?? 0) + 1;
    }
  }
  return counts;
};
