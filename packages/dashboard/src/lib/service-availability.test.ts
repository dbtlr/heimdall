import { describe, expect, test } from 'bun:test';

import type { ServiceDownTransition, ServiceStop } from '../server/service-detail-types.ts';
import {
  availability,
  downSpans,
  isDownStop,
  percentWords,
  stripWindow,
} from './service-availability.ts';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const START = stripWindow(NOW).from;
const EVERY_DAY = Array.from({ length: 90 }, (_, index) => index);

const at = (ms: number) => new Date(ms).toISOString();

// A stop `ago` before now that ran again after `lasted`.
const stop = (ago: number, lasted = 4_000, over: Partial<ServiceStop> = {}): ServiceStop => ({
  exitStatus: 0,
  ongoing: false,
  paired: true,
  receivedAt: at(NOW - ago),
  restarts: 0,
  result: 'success',
  sentAt: at(NOW - ago),
  service: 'web',
  startedAt: at(NOW - ago + lasted),
  stoppedAt: at(NOW - ago),
  system: 'laptop-1',
  ...over,
});

const raised = (ago: number, condition = '7'): ServiceDownTransition => ({
  at: NOW - ago,
  condition,
  kind: 'raised',
  reason: 'Stopped',
});

const cleared = (ago: number, condition = '7'): ServiceDownTransition => ({
  ...raised(ago, condition),
  kind: 'cleared',
});

const states = (found: ReturnType<typeof availability>) => found.days.map(({ state }) => state);

describe('the strip', () => {
  test('is 90 days of up while the System reported and nothing stopped', () => {
    const found = availability({ downs: [], now: NOW, reportDays: EVERY_DAY, stops: [] });
    expect(states(found)).toEqual(Array.from({ length: 90 }, () => 'up'));
    expect(found.days[0]?.from).toBe(START);
    expect(found).toMatchObject({ downPeriods: 0, percent: 100, restarts: 0 });
  });

  test('a day with a stop and no Service down is restarted', () => {
    const found = availability({
      downs: [],
      now: NOW,
      reportDays: EVERY_DAY,
      stops: [stop(10 * DAY + 3 * HOUR)],
    });
    expect(found.days[79]?.state).toBe('restarted');
    expect(states(found).filter((state) => state !== 'up')).toHaveLength(1);
    expect(found.restarts).toBe(1);
  });

  test('a day the Service down Condition was open is down, and across midnight both days', () => {
    const found = availability({
      downs: [raised(5 * DAY + 2 * HOUR), cleared(5 * DAY - 2 * HOUR)],
      now: NOW,
      reportDays: EVERY_DAY,
      stops: [],
    });
    expect(states(found).filter((state) => state === 'down')).toHaveLength(2);
    expect(found.downPeriods).toBe(1);
  });

  test('a stop under a Service down is part of the down period, not a restart', () => {
    const found = availability({
      downs: [raised(2 * HOUR), cleared(HOUR)],
      now: NOW,
      reportDays: EVERY_DAY,
      stops: [stop(2 * HOUR + MINUTE, 10 * MINUTE)],
    });
    expect(found).toMatchObject({ downPeriods: 1, restarts: 0 });
  });

  test('a day with no Reports is quiet, and a stop on it still shows', () => {
    const found = availability({
      downs: [],
      now: NOW,
      reportDays: EVERY_DAY.filter((day) => day !== 3 && day !== 4),
      stops: [stop(86 * DAY + 12 * HOUR)],
    });
    expect(found.days[4]?.state).toBe('quiet');
    expect(found.days[3]?.state).toBe('restarted');
  });

  test('a stop still down counts down to now', () => {
    const found = availability({
      downs: [],
      now: NOW,
      reportDays: EVERY_DAY,
      stops: [stop(2 * DAY, 0, { ongoing: true, startedAt: null })],
    });
    expect(states(found).slice(-3)).toEqual(['up', 'down', 'down']);
  });
});

describe('availability percent', () => {
  test('is the share of the observed time not stopped or down, overlaps counted once', () => {
    const found = availability({
      // 6 hours down, with a 1 hour stop inside it, over 90 days with Reports.
      downs: [raised(10 * HOUR), cleared(4 * HOUR)],
      now: NOW,
      reportDays: EVERY_DAY,
      stops: [stop(8 * HOUR, HOUR)],
    });
    expect(found.percent).toBeCloseTo((1 - 6 / (90 * 24)) * 100, 6);
  });

  test('leaves out days with no Reports', () => {
    const found = availability({
      downs: [raised(2 * HOUR), cleared(HOUR)],
      now: NOW,
      reportDays: EVERY_DAY.slice(45),
      stops: [],
    });
    expect(found.percent).toBeCloseTo((1 - 1 / (45 * 24)) * 100, 6);
  });

  test('is unknown when no day had Reports', () => {
    expect(
      availability({ downs: [], now: NOW, reportDays: [], stops: [] }).percent,
    ).toBeUndefined();
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
