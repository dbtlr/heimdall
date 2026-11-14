import { expect, test } from 'bun:test';

import { atFromSearch, rangeFromSearch } from './range.ts';

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
