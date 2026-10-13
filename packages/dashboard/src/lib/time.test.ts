import { expect, test } from 'bun:test';

import { formatClock, formatCost, formatWhen, spanBox, xPercent } from './time.ts';

const HOUR = 3_600_000;
const NOON = Date.UTC(2026, 9, 13, 12, 0, 0);

test('a clock time is 24-hour in the named zone', () => {
  expect(formatClock(NOON, 'UTC')).toBe('12:00');
  expect(formatClock(NOON + 13 * HOUR + 5 * 60_000, 'UTC')).toBe('01:05');
  expect(formatClock(Date.UTC(2026, 9, 13, 0, 0, 0), 'UTC')).toBe('00:00');
  expect(formatClock(NOON, 'America/Chicago')).toBe('07:00');
  expect(formatClock(NOON, 'Asia/Kolkata')).toBe('17:30');
});

test('a time on the same local day reads as a clock time, another day with its weekday', () => {
  expect(formatWhen(NOON - 2 * HOUR, NOON, 'UTC')).toBe('10:00');
  expect(formatWhen(NOON - 14 * HOUR, NOON, 'UTC')).toBe('Mon 22:00');
});

test('the day is the one in the zone, not in UTC', () => {
  const lateUtc = Date.UTC(2026, 9, 13, 23, 0, 0);
  // 23:00 UTC is already the 14th in Tokyo.
  expect(formatWhen(NOON, lateUtc, 'Asia/Tokyo')).toBe('Tue 21:00');
});

test.each([
  [4.054, '$4.05'],
  [0, '$0.00'],
  [21.5, '$21.50'],
  [undefined, 'cost unknown'],
])('a cost of %p reads %s', (cost, text) => {
  expect(formatCost(cost)).toBe(text);
});

test('x position is a percent of the window', () => {
  const window = { from: 1000, to: 3000 };
  expect(xPercent(1000, window)).toBe(0);
  expect(xPercent(2000, window)).toBe(50);
  expect(xPercent(3000, window)).toBe(100);
});

test('a span is clipped to the window', () => {
  const window = { from: 0, to: 1000 };
  expect(spanBox({ end: 500, start: 250 }, window)).toEqual({ left: 25, width: 25 });
  expect(spanBox({ end: 300, start: -200 }, window)).toEqual({ left: 0, width: 30 });
  expect(spanBox({ end: 1400, start: 900 }, window)).toEqual({ left: 90, width: 10 });
  expect(spanBox({ end: -10, start: -50 }, window).width).toBe(0);
});
