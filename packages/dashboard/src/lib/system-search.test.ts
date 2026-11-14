import { expect, test } from 'bun:test';

import { DESKTOP_TABS, desktopTab, systemSearch } from './system-search.ts';

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
