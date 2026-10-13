import { expect, test } from 'bun:test';

import { atFromSearch, rangeFromSearch, rangeTitle } from './range.ts';

const TO = Date.UTC(2026, 9, 13, 16, 0, 0);

test.each([
  ['6h', 'Last 6 hours, to 16:00'],
  ['12h', 'Last 12 hours, to 16:00'],
  ['24h', 'Last 24 hours, to 16:00'],
  ['7d', 'Last 7 days, to 16:00'],
] as const)('the %s range is titled %s', (range, title) => {
  expect(rangeTitle(range, TO, 'UTC')).toBe(title);
});

test('the range comes from the search, defaulting to 24h', () => {
  expect(rangeFromSearch({ range: '7d' })).toBe('7d');
  expect(rangeFromSearch({})).toBe('24h');
  expect(rangeFromSearch({ range: '3d' })).toBe('24h');
  expect(rangeFromSearch({ range: 7 })).toBe('24h');
});

test('a page can default to another range', () => {
  expect(rangeFromSearch({}, '12h')).toBe('12h');
  expect(rangeFromSearch({ range: '6h' }, '12h')).toBe('6h');
});

test('the time to inspect comes from the search, in whole milliseconds', () => {
  expect(atFromSearch({ at: 1_791_285_510_000.4 })).toBe(1_791_285_510_000);
  expect(atFromSearch({ at: '1791285510000' })).toBe(1_791_285_510_000);
  expect(atFromSearch({})).toBeUndefined();
  expect(atFromSearch({ at: 'noon' })).toBeUndefined();
});
