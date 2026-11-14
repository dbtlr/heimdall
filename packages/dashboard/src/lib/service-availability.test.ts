import { describe, expect, test } from 'bun:test';

import type { ServiceDownTransition, ServiceStop } from '../server/service-detail-types.ts';
import {
  availabilityTotals,
  downSpans,
  isDownStop,
  percentWords,
  stripCalendar,
  stripDays,
} from './service-availability.ts';

// Saturday 24 Oct 2026, 12:00 UTC.
const NOW = Date.UTC(2026, 9, 24, 12, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// The System sent Vitals through all of the strip.
const ALWAYS = [{ from: NOW - 91 * DAY, to: NOW }];

const at = (ms: number) => new Date(ms).toISOString();

// A stop at `stoppedAt` that ran again after `lasted`.
const stopAt = (
  stoppedAt: number,
  lasted = 4_000,
  over: Partial<ServiceStop> = {},
): ServiceStop => ({
  exitStatus: 0,
  ongoing: false,
  paired: true,
  receivedAt: at(stoppedAt),
  restarts: 0,
  result: 'success',
  sentAt: at(stoppedAt),
  service: 'web',
  startedAt: at(stoppedAt + lasted),
  stoppedAt: at(stoppedAt),
  system: 'laptop-1',
  ...over,
});

// A stop `ago` before now that ran again after `lasted`.
const stop = (ago: number, lasted = 4_000, over: Partial<ServiceStop> = {}): ServiceStop =>
  stopAt(NOW - ago, lasted, over);

const raisedAt = (t: number, condition = '7'): ServiceDownTransition => ({
  at: t,
  condition,
  kind: 'raised',
  reason: 'Stopped',
});

const clearedAt = (t: number, condition = '7'): ServiceDownTransition => ({
  ...raisedAt(t, condition),
  kind: 'cleared',
});

const raised = (ago: number, condition = '7') => raisedAt(NOW - ago, condition);
const cleared = (ago: number, condition = '7') => clearedAt(NOW - ago, condition);

type Evidence = Parameters<typeof availabilityTotals>[0];

const days = (over: Partial<Evidence> = {}, timeZone = 'UTC') =>
  stripDays({ downs: [], now: NOW, reported: ALWAYS, stops: [], timeZone, ...over });

const states = (found: ReturnType<typeof stripDays>) => found.map(({ state }) => state);

// The state of the cell that starts at `midnight`.
const stateOn = (found: ReturnType<typeof stripDays>, midnight: number) =>
  found.find(({ from }) => from === midnight)?.state;

const totals = (over: Partial<Evidence> = {}) =>
  availabilityTotals({ downs: [], now: NOW, reported: ALWAYS, stops: [], ...over });

describe('the strip', () => {
  test('is the 90 local calendar days ending today, each from its midnight to the next', () => {
    const found = days();
    expect(states(found)).toEqual(Array.from({ length: 90 }, () => 'up'));
    expect(found[0]?.from).toBe(Date.UTC(2026, 6, 27));
    expect(found.at(-1)).toMatchObject({ from: Date.UTC(2026, 9, 24), to: Date.UTC(2026, 9, 25) });
    expect(found.every((day, index) => index === 0 || day.from === found[index - 1]?.to)).toBe(
      true,
    );
  });

  test('starts each day at midnight in the zone, and keeps a 25-hour day whole', () => {
    // Berlin leaves summer time on 25 Oct 2026.
    const found = stripCalendar(Date.UTC(2026, 10, 2, 12), 'Europe/Berlin');
    const long = found.find(({ from }) => from === Date.UTC(2026, 9, 24, 22));
    expect(long?.to).toBe(Date.UTC(2026, 9, 25, 23));
    expect(found.at(-1)?.from).toBe(Date.UTC(2026, 10, 1, 23));
  });

  test('a stop lands on the calendar date it happened, whatever time of day now is', () => {
    // 08:00 on 23 Oct, earlier in the day than now's 12:00.
    const found = days({ stops: [stopAt(Date.UTC(2026, 9, 23, 8))] });
    expect(stateOn(found, Date.UTC(2026, 9, 23))).toBe('restarted');
    expect(states(found).filter((state) => state !== 'up')).toHaveLength(1);
  });

  test("a stop's date is the viewer's", () => {
    // 23:30 UTC on 22 Oct is 01:30 on 23 Oct in Berlin.
    const stops = [stopAt(Date.UTC(2026, 9, 22, 23, 30))];
    expect(stateOn(days({ stops }), Date.UTC(2026, 9, 22))).toBe('restarted');
    expect(stateOn(days({ stops }, 'Europe/Berlin'), Date.UTC(2026, 9, 22, 22))).toBe('restarted');
  });

  test('a stop that ran again exactly at midnight marks only its own day', () => {
    const found = days({ stops: [stopAt(Date.UTC(2026, 9, 22, 23), HOUR)] });
    expect(states(found).filter((state) => state !== 'up')).toEqual(['restarted']);
    expect(stateOn(found, Date.UTC(2026, 9, 22))).toBe('restarted');
  });

  test('a stop that lasted no time at midnight marks the day it began', () => {
    const found = days({ stops: [stopAt(Date.UTC(2026, 9, 23), 0)] });
    expect(states(found).filter((state) => state !== 'up')).toEqual(['restarted']);
    expect(stateOn(found, Date.UTC(2026, 9, 23))).toBe('restarted');
  });

  test('a day the Service down Condition was open is down, a short one only that day, across midnight both', () => {
    const short = days({
      downs: [raisedAt(Date.UTC(2026, 9, 19, 5, 14)), clearedAt(Date.UTC(2026, 9, 19, 5, 17))],
    });
    expect(states(short).filter((state) => state === 'down')).toHaveLength(1);
    expect(stateOn(short, Date.UTC(2026, 9, 19))).toBe('down');
    const across = days({
      downs: [raisedAt(Date.UTC(2026, 9, 18, 22)), clearedAt(Date.UTC(2026, 9, 19, 2))],
    });
    expect(states(across).filter((state) => state === 'down')).toHaveLength(2);
  });

  test('a day with a stop under a Service down is down', () => {
    const found = days({
      downs: [raised(2 * HOUR), cleared(HOUR)],
      stops: [stop(2 * HOUR + MINUTE, 10 * MINUTE)],
    });
    expect(states(found).at(-1)).toBe('down');
  });

  test('a day with no Reports is quiet, and a stop on another such day still shows', () => {
    const found = days({
      // Vitals stop at the start of 22 Oct and come back at the start of 24 Oct.
      reported: [
        { from: NOW - 91 * DAY, to: Date.UTC(2026, 9, 22) },
        { from: Date.UTC(2026, 9, 24), to: NOW },
      ],
      stops: [stopAt(Date.UTC(2026, 9, 23, 3))],
    });
    expect(states(found).slice(-4)).toEqual(['up', 'quiet', 'restarted', 'up']);
  });

  test('a stop still down counts down to now', () => {
    const found = days({ stops: [stop(2 * DAY, 0, { ongoing: true, startedAt: null })] });
    expect(states(found).slice(-4)).toEqual(['up', 'down', 'down', 'down']);
  });

  test('a Service down raised before the 90 days and cleared inside them is down from the first day', () => {
    const found = days({ downs: [raised(100 * DAY), cleared(85 * DAY)] });
    expect(states(found).slice(0, 7)).toEqual(['down', 'down', 'down', 'down', 'down', 'up', 'up']);
  });
});

describe('the totals', () => {
  test('count down periods and the other stops of the 90 days', () => {
    expect(
      totals({
        downs: [raised(2 * HOUR), cleared(HOUR)],
        stops: [stop(2 * HOUR + MINUTE, 10 * MINUTE), stop(3 * DAY)],
      }),
    ).toMatchObject({ downPeriods: 1, otherStops: 1 });
  });

  test('count a Service down that began before the 90 days, and leave out one that ended before them', () => {
    const found = totals({
      downs: [raised(100 * DAY), cleared(85 * DAY), raised(95 * DAY, '8'), cleared(91 * DAY, '8')],
    });
    expect(found.downPeriods).toBe(1);
    expect(found.percent).toBeCloseTo((1 - 5 / 90) * 100, 6);
  });

  test('leave out a stop that began before the 90 days', () => {
    expect(totals({ stops: [stop(91 * DAY, 2 * DAY)] }).otherStops).toBe(0);
  });
});

describe('a stop whose end is unknown', () => {
  // Stopped at 08:00 on 23 Oct; the System's Reports resume at 09:00.
  const lost = stopAt(Date.UTC(2026, 9, 23, 8), 0, { startedAt: null });
  const gap = [
    { from: NOW - 91 * DAY, to: Date.UTC(2026, 9, 23, 8, 1) },
    { from: Date.UTC(2026, 9, 23, 9), to: NOW },
  ];

  test('is downtime until the System next reports, so the percent is below 100', () => {
    const found = totals({ reported: gap, stops: [lost] });
    expect(found.percent).toBeCloseTo((1 - 1 / (90 * 24 - 12 - 1 / 60)) * 100, 3);
    expect(percentWords(found.percent)).not.toBe('100.00%');
  });

  test('lasts until the next Report while the System kept reporting, not until its next gap', () => {
    // Stopped 40 days ago; Reports ran on, with a 10-minute gap 10 days ago.
    const kept = stop(40 * DAY, 0, { startedAt: null });
    const reported = [
      { from: NOW - 91 * DAY, to: NOW - 10 * DAY },
      { from: NOW - 10 * DAY + 10 * MINUTE, to: NOW },
    ];
    // The next bucket of Reports began 5 minutes after the stop.
    expect(totals({ reported, stops: [kept] }).percent).toBeCloseTo(
      (1 - 5 / (90 * 24 * 60 - 10)) * 100,
      6,
    );
    const restarted = states(days({ reported, stops: [kept] })).filter(
      (state) => state === 'restarted',
    );
    expect(restarted).toEqual(['restarted']);
  });

  test('is downtime to the end of its day when no Report came after it', () => {
    const found = totals({
      reported: [{ from: NOW - 91 * DAY, to: Date.UTC(2026, 9, 23, 8, 1) }],
      stops: [lost],
    });
    expect(found.percent).toBeLessThan(100);
    // 08:00 to midnight is 16 hours of the 90 days' known time.
    expect(found.percent).toBeCloseTo((1 - 16 / (90 * 24 - 12 - 16)) * 100, 0);
  });
});

describe('availability percent', () => {
  test('is the share of the observed time not stopped or down, overlaps counted once', () => {
    const found = totals({
      // 6 hours down, with a 1 hour stop inside it, over 90 days with Reports.
      downs: [raised(10 * HOUR), cleared(4 * HOUR)],
      stops: [stop(8 * HOUR, HOUR)],
    });
    expect(found.percent).toBeCloseTo((1 - 6 / (90 * 24)) * 100, 6);
  });

  test('leaves out the time with no Reports', () => {
    const found = totals({
      downs: [raised(2 * HOUR), cleared(HOUR)],
      reported: [{ from: NOW - 45 * DAY, to: NOW }],
    });
    expect(found.percent).toBeCloseTo((1 - 1 / (45 * 24)) * 100, 6);
  });

  test('counts a stop with no Reports around it as known down time', () => {
    const found = totals({
      reported: [{ from: NOW - 45 * DAY, to: NOW - 2 * HOUR }],
      stops: [stop(HOUR, HOUR)],
    });
    expect(found.percent).toBeCloseTo((1 - 1 / (45 * 24 - 1)) * 100, 6);
  });

  test('is unknown when the System sent no Vitals and nothing stopped', () => {
    expect(totals({ reported: [] }).percent).toBeUndefined();
  });

  test('is never rounded up to 100 or to the next hundredth', () => {
    expect(percentWords(99.999_9)).toBe('99.99%');
    expect(percentWords(100)).toBe('100.00%');
    expect(percentWords(undefined)).toBeUndefined();
  });
});

describe('down spans', () => {
  test('a raise ends at its clear, or at now while open', () => {
    expect(downSpans([raised(3 * HOUR), cleared(2 * HOUR), raised(HOUR, '8')], NOW)).toEqual([
      { from: NOW - 3 * HOUR, to: NOW - 2 * HOUR },
      { from: NOW - HOUR, to: NOW },
    ]);
  });

  test('a stop is down when its span meets a down span', () => {
    const spans = downSpans([raised(3 * HOUR), cleared(2 * HOUR)], NOW);
    expect(isDownStop(stop(3 * HOUR + 30 * MINUTE, HOUR), spans, NOW)).toBe(true);
    expect(isDownStop(stop(HOUR), spans, NOW)).toBe(false);
  });
});
