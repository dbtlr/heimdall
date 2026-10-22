import { expect, test } from 'bun:test';

import {
  formatClock,
  formatAhead,
  formatClockSeconds,
  formatCost,
  formatSpanShort,
  formatTime,
  formatWhen,
  spanBox,
  xPercent,
} from './time.ts';

const HOUR = 3_600_000;
const NOON = Date.UTC(2026, 9, 13, 12, 0, 0);

test('a clock time is 24-hour in the named zone', () => {
  expect(formatClock(NOON, 'UTC')).toBe('12:00');
  expect(formatClock(NOON + 13 * HOUR + 5 * 60_000, 'UTC')).toBe('01:05');
  expect(formatClock(Date.UTC(2026, 9, 13, 0, 0, 0), 'UTC')).toBe('00:00');
  expect(formatClock(NOON, 'America/Chicago')).toBe('07:00');
  expect(formatClock(NOON, 'Asia/Kolkata')).toBe('17:30');
});

test('a clock time to the second keeps the leading zeros', () => {
  expect(formatClockSeconds(NOON + 5 * 60_000 + 7000, 'UTC')).toBe('12:05:07');
  expect(formatClockSeconds(NOON + 13 * HOUR, 'UTC')).toBe('01:00:00');
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

// 2026-10-13 22:30 UTC: Tuesday 18:30 in New York, already Wednesday 00:30 in Berlin.
const DAY_BOUNDARY = Date.UTC(2026, 9, 13, 22, 30, 15);

test.each([
  ['clock', 'Europe/Berlin', '00:30'],
  ['clock', 'America/New_York', '18:30'],
  ['clockSeconds', 'Europe/Berlin', '00:30:15'],
  ['clockSeconds', 'America/New_York', '18:30:15'],
  ['weekday', 'Europe/Berlin', 'Wed'],
  ['weekday', 'America/New_York', 'Tue'],
] as const)('one instant formats as %s in %s: %s', (format, zone, text) => {
  expect(formatTime(DAY_BOUNDARY, zone, { format })).toBe(text);
});

test.each([
  // An hour earlier it was Tuesday 23:30 in Berlin, still today in New York.
  ['Europe/Berlin', 'Wed 00:30'],
  ['America/New_York', '18:30'],
] as const)('a time relative to now reads by the local day in %s', (zone, text) => {
  expect(formatTime(DAY_BOUNDARY, zone, { format: 'when', now: DAY_BOUNDARY - HOUR })).toBe(text);
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

test('a time ahead names its weekday within the coming week, and its date beyond', () => {
  expect(formatAhead(NOON + 2 * HOUR, NOON, 'UTC')).toBe('14:00');
  expect(formatAhead(NOON + 6 * 24 * HOUR, NOON, 'UTC')).toBe('Mon 12:00');
  expect(formatAhead(NOON + 7 * 24 * HOUR, NOON, 'UTC')).toBe('Tue 20 Oct 12:00');
  expect(formatAhead(NOON + 300 * 24 * HOUR, NOON, 'UTC')).toBe('Mon 9 Aug 12:00');
});

test('a time ahead counts days in the named zone', () => {
  // At 22:00 UTC it is already the next day in Tokyo, so the time is six local
  // days ahead there, not seven.
  expect(formatAhead(NOON + 7 * 24 * HOUR - 3 * HOUR, NOON + 10 * HOUR, 'Asia/Tokyo')).toBe(
    'Tue 18:00',
  );
});

test('a short span keeps only its largest unit, rounded down', () => {
  expect(formatSpanShort(20_000)).toBe('20 s');
  expect(formatSpanShort(4 * 60_000 + 59_000)).toBe('4 min');
  expect(formatSpanShort(7 * HOUR + 33 * 60_000)).toBe('7 h');
  expect(formatSpanShort(51 * HOUR)).toBe('2 d');
  expect(formatSpanShort(59_600)).toBe('59 s');
  expect(formatSpanShort(-5000)).toBe('0 s');
});
