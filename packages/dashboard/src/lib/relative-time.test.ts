import { expect, test } from 'bun:test';

import { relativeTime } from './relative-time.ts';

const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

test.each([
  [0, '0 s ago'],
  [12_000, '12 s ago'],
  [59_999, '59 s ago'],
  [60_000, '1 min ago'],
  [59 * 60_000, '59 min ago'],
  [60 * 60_000, '1 h ago'],
  [47 * 3_600_000, '47 h ago'],
  [48 * 3_600_000, '2 d ago'],
])('%d ms before now reads %s', (age, text) => {
  expect(relativeTime(NOW - age, NOW)).toBe(text);
});

test('a time slightly ahead of now (clock skew) reads as now', () => {
  expect(relativeTime(NOW + 5000, NOW)).toBe('0 s ago');
});
