import { expect, test } from 'bun:test';

import { rangeFromSearch, rangeTitle } from './range.ts';

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
