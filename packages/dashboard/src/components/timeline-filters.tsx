import {
  emptyTimelineFilters,
  filterTimeline,
  TIMELINE_LEVELS,
  TIMELINE_STATUSES,
  timelineFilterCounts,
} from '../lib/timeline-filters.ts';
import type { TimelineFilters, TimelineLevel, TimelineStatus } from '../lib/timeline-filters.ts';
import { ActiveFilters, FilterControl, FilterSheet, toggle } from './filter-sheet.tsx';

type FilterableEntry = {
  clearedAt: number | undefined;
  level: TimelineLevel;
  paired: boolean;
  system: string;
};

const LEVEL_NAMES: Record<TimelineLevel, string> = {
  alert: 'Alert',
  note: 'Note',
  warning: 'Warning',
};
const STATUS_NAMES: Record<TimelineStatus, string> = { cleared: 'Cleared', open: 'Open' };
const NOUN = 'occurrences';
const TITLE = 'Filter Timeline';
const TITLE_ID = 'timeline-filter-title';

type FilterProps = { filters: TimelineFilters; onChange: (filters: TimelineFilters) => void };

// A System as the page names it: unpaired Systems say their history is kept.
const systemLabel = (system: string, unpaired: ReadonlySet<string>) =>
  unpaired.has(system) ? `${system} · Unpaired · history kept` : system;
const unpairedSystems = (entries: readonly FilterableEntry[]) =>
  new Set(entries.filter((entry) => !entry.paired).map((entry) => entry.system));

const toggleIn = (filters: TimelineFilters, section: string, value: string): TimelineFilters => {
  const level = TIMELINE_LEVELS.find((known) => known === value);
  const status = TIMELINE_STATUSES.find((known) => known === value);
  if (section === 'level' && level !== undefined) {
    return { ...filters, level: toggle(filters.level, level) };
  }
  if (section === 'status' && status !== undefined) {
    return { ...filters, status: toggle(filters.status, status) };
  }
  return section === 'system' ? { ...filters, system: toggle(filters.system, value) } : filters;
};

const sheetFor = (entries: readonly FilterableEntry[], filters: TimelineFilters) => {
  const counts = timelineFilterCounts(entries, filters);
  const unpaired = unpairedSystems(entries);
  return {
    sections: [
      {
        chips: TIMELINE_LEVELS.map((level) => ({
          count: counts.level[level],
          label: LEVEL_NAMES[level],
          selected: filters.level.includes(level),
          value: level,
        })),
        key: 'level',
        title: 'Level',
      },
      {
        chips: Object.keys(counts.system)
          .toSorted((a, b) => a.localeCompare(b))
          .map((system) => ({
            count: counts.system[system] ?? 0,
            label: systemLabel(system, unpaired),
            selected: filters.system.includes(system),
            value: system,
          })),
        key: 'system',
        title: 'System',
      },
      {
        chips: TIMELINE_STATUSES.map((status) => ({
          count: counts.status[status],
          label: STATUS_NAMES[status],
          selected: filters.status.includes(status),
          value: status,
        })),
        key: 'status',
        title: 'Status',
      },
    ],
    shown: filterTimeline(entries, filters).length,
  };
};

export function ActiveTimelineFilters({
  entries,
  filters,
  onChange,
}: FilterProps & { entries: readonly FilterableEntry[] }) {
  const unpaired = unpairedSystems(entries);
  return (
    <ActiveFilters
      onClear={() => onChange(emptyTimelineFilters())}
      pills={[
        ...filters.level.map((level) => ({
          key: `level:${level}`,
          label: LEVEL_NAMES[level],
          remove: () => onChange({ ...filters, level: toggle(filters.level, level) }),
        })),
        ...filters.system.map((system) => ({
          key: `system:${system}`,
          label: systemLabel(system, unpaired),
          remove: () => onChange({ ...filters, system: toggle(filters.system, system) }),
        })),
        ...filters.status.map((status) => ({
          key: `status:${status}`,
          label: STATUS_NAMES[status],
          remove: () => onChange({ ...filters, status: toggle(filters.status, status) }),
        })),
      ]}
    />
  );
}

export function TimelineFilterSheet({
  entries,
  filters,
  onApply,
  onChange,
  onClose,
  open,
}: FilterProps & {
  entries: readonly FilterableEntry[];
  onApply: () => void;
  onClose: () => void;
  open: boolean;
}) {
  return (
    <FilterSheet
      {...sheetFor(entries, filters)}
      noun={NOUN}
      onApply={onApply}
      onClear={() => onChange(emptyTimelineFilters())}
      onClose={onClose}
      onToggle={(section, value) => onChange(toggleIn(filters, section, value))}
      open={open}
      title={TITLE}
      titleId={TITLE_ID}
    />
  );
}

export function TimelineFilterControl({
  entries,
  filters,
  onChange,
}: FilterProps & { entries: readonly FilterableEntry[] }) {
  return (
    <FilterControl
      activeCount={filters.level.length + filters.system.length + filters.status.length}
      empty={emptyTimelineFilters}
      filters={filters}
      noun={NOUN}
      onChange={onChange}
      sheetFor={(draft) => sheetFor(entries, draft)}
      title={TITLE}
      titleId={TITLE_ID}
      toggleIn={toggleIn}
    />
  );
}
