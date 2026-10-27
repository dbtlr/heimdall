import { expect, test } from 'bun:test';

import {
  emptyTimelineFilters,
  filterTimeline,
  timelineFilterCounts,
  timelineSearch,
} from './timeline-filters.ts';
import type { TimelineLevel } from './timeline-filters.ts';

const entry = (id: string, system: string, level: TimelineLevel, cleared: boolean) => ({
  clearedAt: cleared ? 1 : undefined,
  id,
  level,
  system,
});
const entries = [
  entry('1', 'alpha', 'alert', false),
  entry('2', 'beta', 'warning', true),
  entry('3', 'alpha', 'note', true),
  entry('4', 'beta', 'alert', false),
];
const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);

test('no selection keeps every entry in order', () => {
  expect(ids(filterTimeline(entries, emptyTimelineFilters()))).toEqual(['1', '2', '3', '4']);
});

test('a section matches any of its values, sections combine, order is kept', () => {
  expect(
    ids(filterTimeline(entries, { ...emptyTimelineFilters(), level: ['note', 'alert'] })),
  ).toEqual(['1', '3', '4']);
  expect(
    ids(filterTimeline(entries, { level: ['alert'], status: ['open'], system: ['beta'] })),
  ).toEqual(['4']);
  expect(ids(filterTimeline(entries, { ...emptyTimelineFilters(), status: ['cleared'] }))).toEqual([
    '2',
    '3',
  ]);
});

test('counts describe each chip constrained by the other sections only', () => {
  expect(timelineFilterCounts(entries, emptyTimelineFilters())).toEqual({
    level: { alert: 2, note: 1, warning: 1 },
    status: { cleared: 2, open: 2 },
    system: { alpha: 2, beta: 2 },
  });
  expect(
    timelineFilterCounts(entries, { level: ['alert'], status: ['open'], system: ['beta'] }),
  ).toEqual({
    level: { alert: 1, note: 0, warning: 0 },
    status: { cleared: 0, open: 1 },
    system: { alpha: 1, beta: 1 },
  });
});

test('a selected chip with no entries counts zero and stays listed', () => {
  const counts = timelineFilterCounts(entries, {
    level: ['warning'],
    status: ['open'],
    system: [],
  });
  expect(counts.level.warning).toBe(0);
  expect(counts.system).toEqual({ alpha: 0, beta: 0 });
});

test('search drops unknown values and leaves empty params undefined', () => {
  expect(timelineSearch({})).toEqual({ level: undefined, status: undefined, system: undefined });
  expect(
    timelineSearch({ level: ['alert', 'bogus', 'alert'], status: 'open', system: ['a', 3] }),
  ).toEqual({ level: ['alert'], status: ['open'], system: ['a', '3'] });
  expect(timelineSearch({ level: 'bogus', status: ['nope'] }).level).toBeUndefined();
});

test('search keeps finite numbers inside a System array as strings', () => {
  expect(timelineSearch({ system: ['a', 3, Number.NaN, 3] }).system).toEqual(['a', '3']);
});

test('a selected System with no loaded entries is listed at zero, after the loaded ones', () => {
  const counts = timelineFilterCounts(entries, { ...emptyTimelineFilters(), system: ['aged-out'] });
  expect(Object.keys(counts.system)).toEqual(['alpha', 'beta', 'aged-out']);
  expect(counts.system['aged-out']).toBe(0);
});
