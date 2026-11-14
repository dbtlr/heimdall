import { expect, test } from 'bun:test';

import { DESKTOP_TABS, desktopTab, rangeHolding, systemSearch } from './system-search.ts';

test('a link to the tab by its old name, Timeline, opens Activity', () => {
  expect(systemSearch({ tab: 'timeline' }).tab).toBe('activity');
});

test('a System opens on Now, while an existing sample link opens Vitals', () => {
  expect(systemSearch({})).toEqual({ at: undefined, range: '12h', tab: 'now' });
  expect(systemSearch({ at: 1234, range: '24h' })).toEqual({
    at: 1234,
    range: '24h',
    tab: 'vitals',
  });
});

test('System tabs validate shared links without dropping their range or sample', () => {
  expect(systemSearch({ at: 1234, range: '7d', tab: 'sessions' })).toEqual({
    at: 1234,
    range: '7d',
    tab: 'sessions',
  });
  expect(systemSearch({ at: 'bad', range: 'bad', tab: 'bad' })).toEqual({
    at: undefined,
    range: '12h',
    tab: 'now',
  });
});

test('on a wide screen Now, Vitals, and Sessions are one Overview, and Records and Activity keep their tabs', () => {
  expect(DESKTOP_TABS.map(({ name }) => name)).toEqual(['Overview', 'Records', 'Activity']);
  expect(desktopTab('now')).toBe('overview');
  expect(desktopTab('vitals')).toBe('overview');
  expect(desktopTab('sessions')).toBe('overview');
  expect(desktopTab('records')).toBe('records');
  expect(desktopTab('activity')).toBe('activity');
});

test('a link to a sample opens the shortest range that still holds it', () => {
  const HOUR = 60 * 60_000;
  const NOW = Date.UTC(2026, 10, 14, 12);
  expect(rangeHolding(NOW - HOUR, NOW)).toBe('6h');
  expect(rangeHolding(NOW - 6 * HOUR, NOW)).toBe('6h');
  expect(rangeHolding(NOW - 7 * HOUR, NOW)).toBe('12h');
  expect(rangeHolding(NOW - 13 * HOUR, NOW)).toBe('24h');
  expect(rangeHolding(NOW - 3 * 24 * HOUR, NOW)).toBe('7d');
  expect(rangeHolding(NOW - 20 * 24 * HOUR, NOW)).toBe('7d');
});
