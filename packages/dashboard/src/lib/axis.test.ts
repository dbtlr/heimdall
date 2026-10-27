import { describe, expect, test } from 'bun:test';

import { axisTicks, spanTicks } from './axis.ts';

const HOUR = 3_600_000;
const TO = Date.UTC(2026, 9, 13, 16, 0, 0);
const T_SPAN = Date.UTC(2026, 9, 13, 16, 0, 0);

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

test.each([
  // Berlin is UTC+2 in October, so its midnights are at 22:00 UTC the day before.
  [
    'Europe/Berlin',
    [
      [8, 22, 'Fri'],
      [9, 22, 'Sat'],
      [10, 22, 'Sun'],
      [11, 22, 'Mon'],
      [12, 22, 'Tue'],
    ],
  ],
] as const)('7d day ticks sit at local midnight in %s', (zone, midnights) => {
  const to = Date.UTC(2026, 9, 14, 12, 0, 0);
  const ticks = axisTicks('7d', { from: to - 7 * 24 * HOUR, to }, zone);
  expect(ticks.slice(1, -1).map(({ at, label }) => [at, label])).toEqual(
    midnights.map(([day, hour, label]) => [Date.UTC(2026, 9, day, hour), label]),
  );
});

test('ticks fall on round times in the zone, not in UTC', () => {
  // 30-minute zone: round local hours are at :30 UTC.
  const ticks = axisTicks('6h', { from: TO - 6 * HOUR, to: TO }, 'Asia/Kolkata');
  expect(labels(ticks)).toEqual(['15:30', '17:00', '18:00', '19:00', '20:00', 'now']);
});

// How many ticks a window of `minutes` has between its ends; it starts 17 s
// off a minute so no tick lands on an end.
const spanTickCount = (minutes: number): number =>
  spanTicks({ from: T_SPAN + 17_000, to: T_SPAN + 17_000 + minutes * 60_000 }, 'UTC').length - 2;
describe('spanTicks', () => {
  const MINUTE = 60_000;
  const FROM = Date.UTC(2026, 9, 13, 16, 0, 0);

  test('the first tick is the start and the last is the end clock time, never "now"', () => {
    const ticks = spanTicks({ from: FROM, to: FROM + HOUR }, 'UTC');
    expect(ticks[0]).toMatchObject({ at: FROM, edge: 'start', label: '16:00', minor: false });
    expect(ticks.at(-1)).toMatchObject({ at: FROM + HOUR, edge: 'end', label: '17:00' });
  });

  test('an hour gets a tick every 10 minutes, alternating major and minor', () => {
    const ticks = spanTicks({ from: FROM, to: FROM + HOUR }, 'UTC');
    expect(labels(ticks)).toEqual(['16:00', '16:10', '16:20', '16:30', '16:40', '16:50', '17:00']);
    expect(ticks.slice(1, -1).map((tick) => tick.minor)).toEqual([true, false, true, false, true]);
  });

  test('a window under a minute has only its two ends', () => {
    const ticks = spanTicks({ from: FROM + 5_000, to: FROM + 35_000 }, 'UTC');
    expect(ticks.map((tick) => tick.edge)).toEqual(['start', 'end']);
  });

  test('under 10 minutes the labels show seconds', () => {
    const ticks = spanTicks({ from: FROM - 30_000, to: FROM + 5 * MINUTE + 30_000 }, 'UTC');
    expect(labels(ticks)).toEqual([
      '15:59:30',
      '16:01:00',
      '16:02:00',
      '16:03:00',
      '16:04:00',
      '16:05:30',
    ]);
  });

  test('from 10 minutes up the labels drop the seconds', () => {
    const ticks = spanTicks({ from: FROM + 17_000, to: FROM + 17_000 + 10 * MINUTE }, 'UTC');
    expect(labels(ticks)[0]).toBe('16:00');
  });

  test('a 1-minute and a 3-minute window have no repeated label', () => {
    for (const minutes of [1, 3]) {
      const from = FROM + 17_000;
      const found = labels(spanTicks({ from, to: from + minutes * MINUTE }, 'UTC'));
      expect(new Set(found).size).toBe(found.length);
    }
  });

  test('a day ticks every 3 hours', () => {
    const from = Date.UTC(2026, 9, 13, 1, 0, 0);
    const ticks = spanTicks({ from, to: from + 24 * HOUR }, 'UTC');
    // 03:00 and 00:00 are within 10% of the ends and dropped.
    expect(labels(ticks)).toEqual([
      '01:00',
      '06:00',
      '09:00',
      '12:00',
      '15:00',
      '18:00',
      '21:00',
      '01:00',
    ]);
  });

  test('a window over 2 days ticks each local midnight by weekday, the ends with clock times', () => {
    // Tuesday 05:00 to Friday 05:00; Friday's midnight is too close to the end.
    const from = Date.UTC(2026, 9, 13, 5, 0, 0);
    const ticks = spanTicks({ from, to: from + 72 * HOUR }, 'UTC');
    expect(labels(ticks)).toEqual(['Tue 05:00', 'Wed', 'Thu', 'Fri 05:00']);
    expect(ticks[1]?.at).toBe(Date.UTC(2026, 9, 14));
  });

  test('every other midnight is minor', () => {
    const from = Date.UTC(2026, 9, 13, 5, 0, 0);
    const ticks = spanTicks({ from, to: from + 5 * 24 * HOUR }, 'UTC');
    const between = ticks.slice(1, -1).map((tick) => tick.minor);
    expect(between).toHaveLength(4);
    expect(between[0]).not.toBe(between[1]);
    expect(between[0]).toBe(between[2]);
  });

  test('a 5-day and a 14-day window have at most 9 ticks, labeled by weekday', () => {
    const from = Date.UTC(2026, 9, 13, 5, 0, 0);
    for (const days of [5, 14]) {
      const ticks = spanTicks({ from, to: from + days * 24 * HOUR }, 'UTC');
      expect(ticks.length).toBeLessThanOrEqual(9);
      expect(labels(ticks.slice(1, -1)).every((label) => /^[A-Z][a-z]{2}$/.test(label))).toBe(true);
      expect(labels(ticks)[0]).toBe('Tue 05:00');
    }
  });

  test('a 14-day window ticks every other midnight', () => {
    const from = Date.UTC(2026, 9, 13, 5, 0, 0);
    const ticks = spanTicks({ from, to: from + 14 * 24 * HOUR }, 'UTC');
    const gaps = ticks.slice(1, -1).map((tick, index, all) => tick.at - (all[index - 1]?.at ?? 0));
    expect(gaps.slice(1).every((gap) => gap === 48 * HOUR)).toBe(true);
  });

  test('a window of weeks ticks each Monday midnight', () => {
    const from = Date.UTC(2026, 9, 13, 5, 0, 0);
    const ticks = spanTicks({ from, to: from + 60 * 24 * HOUR }, 'UTC');
    expect(ticks.length).toBeLessThanOrEqual(10);
    expect(labels(ticks.slice(1, -1)).every((label) => label === 'Mon')).toBe(true);
  });

  test('midnights are local to the zone', () => {
    const from = Date.UTC(2026, 9, 13, 5, 0, 0);
    const ticks = spanTicks({ from, to: from + 72 * HOUR }, 'Asia/Kolkata');
    // 00:00 in Kolkata is 18:30 UTC the day before.
    expect(ticks[1]?.at).toBe(Date.UTC(2026, 9, 13, 18, 30));
  });

  test('picks the smallest step that leaves at most 8 intervals', () => {
    // 40 minutes at 5 minute steps is 8 intervals; 41 needs 10-minute steps.
    expect(spanTickCount(40)).toBe(7);
    expect(spanTickCount(41)).toBe(3);
    // 8 hours at 1 hour steps is 8 intervals; just over needs 2-hour steps.
    expect(spanTickCount(8 * 60)).toBe(7);
    expect(spanTickCount(8 * 60 + 1)).toBe(3);
  });

  test('a round tick within 10% of the start is dropped', () => {
    // 16:10 is 2 of 47 minutes in; 16:50 is 5 minutes from the end and stays.
    const ticks = spanTicks({ from: FROM + 8 * MINUTE, to: FROM + 55 * MINUTE }, 'UTC');
    expect(labels(ticks)).toEqual(['16:08', '16:20', '16:30', '16:40', '16:50', '16:55']);
  });

  test('a round tick within 10% of the end is dropped', () => {
    const ticks = spanTicks({ from: FROM + 2 * MINUTE, to: FROM + 52 * MINUTE }, 'UTC');
    expect(labels(ticks)).toEqual(['16:02', '16:10', '16:20', '16:30', '16:40', '16:52']);
  });

  test('ticks fall on round times in the zone, not in UTC', () => {
    const ticks = spanTicks({ from: FROM, to: FROM + 6 * HOUR }, 'Asia/Kolkata');
    expect(labels(ticks)).toEqual(['21:30', '23:00', '00:00', '01:00', '02:00', '03:30']);
  });
});
