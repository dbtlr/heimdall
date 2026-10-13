import { expect, test } from 'bun:test';

import { axisTicks } from './axis.ts';

const HOUR = 3_600_000;
const TO = Date.UTC(2026, 9, 13, 16, 0, 0);

const labels = (ticks: ReturnType<typeof axisTicks>) => ticks.map((tick) => tick.label);

test('24h ticks every 4 hours from the first, alternating major and minor', () => {
  const ticks = axisTicks('24h', { from: TO - 24 * HOUR, to: TO }, 'UTC');
  expect(labels(ticks)).toEqual(['16:00', '20:00', '00:00', '04:00', '08:00', '12:00', 'now']);
  expect(ticks.map((tick) => tick.minor)).toEqual([false, true, false, true, false, true, false]);
  expect(ticks[0]).toMatchObject({ at: TO - 24 * HOUR, edge: 'start' });
  expect(ticks.at(-1)).toMatchObject({ at: TO, edge: 'end' });
});

test('6h ticks every hour, major on the even ones', () => {
  const ticks = axisTicks('6h', { from: TO - 6 * HOUR, to: TO }, 'UTC');
  expect(labels(ticks)).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', 'now']);
  expect(ticks.filter((tick) => !tick.minor).map((tick) => tick.label)).toEqual([
    '10:00',
    '12:00',
    '14:00',
    'now',
  ]);
});

test('12h ticks every 2 hours', () => {
  const ticks = axisTicks('12h', { from: TO - 12 * HOUR, to: TO }, 'UTC');
  expect(labels(ticks)).toEqual(['04:00', '06:00', '08:00', '10:00', '12:00', '14:00', 'now']);
});

test('a round tick close to the first label or to now is dropped', () => {
  // From 16:30 to 16:30: 20:00 is 14.6% in, 16:00 is 2% before the end.
  const to = TO + 30 * 60_000;
  const ticks = axisTicks('24h', { from: to - 24 * HOUR, to }, 'UTC');
  expect(labels(ticks)).toEqual(['16:30', '20:00', '00:00', '04:00', '08:00', '12:00', 'now']);
  // From 17:50: 20:00 is 9% in, too close to the start.
  const late = Date.UTC(2026, 9, 13, 17, 50, 0);
  expect(labels(axisTicks('24h', { from: late - 24 * HOUR, to: late }, 'UTC'))[1]).toBe('00:00');
});

test('7d ticks each local midnight by weekday', () => {
  const ticks = axisTicks('7d', { from: TO - 7 * 24 * HOUR, to: TO }, 'UTC');
  // 2026-10-13 is a Tuesday; the window starts Tuesday 16:00. The midnights
  // closer than 10% to either end, Wednesday's and this Tuesday's, are dropped.
  expect(labels(ticks)).toEqual(['Tue', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'now']);
  // Every other day is major, so a narrow screen keeps those.
  expect(ticks.map((tick) => tick.minor)).toEqual([false, true, false, true, false, true, false]);
});

test('ticks fall on round times in the zone, not in UTC', () => {
  // 30-minute zone: round local hours are at :30 UTC.
  const ticks = axisTicks('6h', { from: TO - 6 * HOUR, to: TO }, 'Asia/Kolkata');
  expect(labels(ticks)).toEqual(['15:30', '17:00', '18:00', '19:00', '20:00', 'now']);
});
