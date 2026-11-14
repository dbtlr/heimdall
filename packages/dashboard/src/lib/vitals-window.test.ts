import { describe, expect, test } from 'bun:test';

import type { VitalsWindow } from '../server/vitals-window-types.ts';
import {
  AROUND_MS,
  aroundSpan,
  MAX_POINTS,
  RAW_RETENTION_MS,
  vitalsBuckets,
  vitalsView,
} from './vitals-window.ts';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('the span around a moment', () => {
  test('takes 30 minutes either side', () => {
    expect(aroundSpan({ from: NOW - 5 * HOUR, to: NOW - 4 * HOUR }, NOW)).toEqual({
      from: NOW - 5 * HOUR - AROUND_MS,
      to: NOW - 4 * HOUR + AROUND_MS,
    });
  });

  test('ends at now for a moment still going on', () => {
    expect(aroundSpan({ from: NOW - 10 * MINUTE, to: NOW }, NOW)).toEqual({
      from: NOW - 40 * MINUTE,
      to: NOW,
    });
  });

  test('never ends before the moment starts, as when the System clock put it after now', () => {
    expect(aroundSpan({ from: NOW + HOUR, to: NOW + HOUR }, NOW)).toEqual({
      from: NOW + 30 * MINUTE,
      to: NOW + HOUR,
    });
  });
});

describe('how a window is read', () => {
  test('averages raw samples over a minute or two within their retention', () => {
    expect(vitalsBuckets({ from: NOW - HOUR, to: NOW }, NOW)).toEqual({
      bucketMs: MINUTE,
      source: 'samples',
    });
    expect(
      vitalsBuckets({ from: NOW - RAW_RETENTION_MS, to: NOW - RAW_RETENTION_MS + 6 * HOUR }, NOW),
    ).toEqual({ bucketMs: 2 * MINUTE, source: 'samples' });
  });

  test('reads rollups once the window starts before the samples are kept', () => {
    expect(
      vitalsBuckets({ from: NOW - RAW_RETENTION_MS - 1, to: NOW - RAW_RETENTION_MS + HOUR }, NOW),
    ).toEqual({ bucketMs: 5 * MINUTE, source: 'rollups' });
  });

  test('reads rollups once a point would average a rollup or more', () => {
    expect(vitalsBuckets({ from: NOW - 6 * HOUR - MINUTE, to: NOW }, NOW)).toEqual({
      bucketMs: 5 * MINUTE,
      source: 'rollups',
    });
  });

  test('draws at most MAX_POINTS points however long the window', () => {
    for (const span of [HOUR, 3 * DAY, 30 * DAY, 365 * DAY]) {
      const { bucketMs } = vitalsBuckets({ from: NOW - span, to: NOW }, NOW);
      expect(Math.ceil(span / bucketMs)).toBeLessThanOrEqual(MAX_POINTS);
    }
    expect(vitalsBuckets({ from: NOW - 365 * DAY, to: NOW }, NOW).bucketMs).toBe(3 * DAY);
  });
});

const vitals = (over: Partial<VitalsWindow> = {}): VitalsWindow => ({
  bucketMs: MINUTE,
  from: NOW - HOUR,
  limits: { cpuPercent: 85, memoryPercent: 90 },
  points: [
    { cpu: 10, load: 0.5, memory: 40, t: NOW - 50 * MINUTE },
    { cpu: 78.456, load: 3.126, memory: 45, t: NOW - 45 * MINUTE },
  ],
  source: 'samples',
  to: NOW,
  ...over,
});

describe('the charts', () => {
  test('one per reading, with the limit lines and each highest reading', () => {
    const view = vitalsView(vitals());
    expect(view.charts.map(({ key, max }) => [key, max])).toEqual([
      ['cpu', '78.46% max'],
      ['memory', '45% max'],
      ['load', '3.13 max'],
    ]);
    expect(view.charts[0]?.chart.lines).toEqual([{ label: '85%', level: 'note', value: 85 }]);
    expect(view.charts[2]?.chart.lines).toEqual([]);
    expect(view.source).toBe('1-minute averages');
  });

  test('a limit the Hub does not judge by draws no line', () => {
    const view = vitalsView(
      vitals({ limits: { cpuPercent: undefined, memoryPercent: undefined } }),
    );
    expect(view.charts.flatMap(({ chart }) => chart.lines)).toEqual([]);
  });

  test('a window with no reading is empty, and its charts say so', () => {
    const view = vitalsView(vitals({ bucketMs: 6 * HOUR, points: [], source: 'rollups' }));
    expect(view.empty).toBe(true);
    expect(view.charts.map(({ max }) => max)).toEqual(['No reading', 'No reading', 'No reading']);
    expect(view.source).toBe('6-hour averages');
  });

  test('the load scale reaches the highest reading in whole steps', () => {
    const view = vitalsView(
      vitals({ points: [{ cpu: 1, load: 12.2, memory: 1, t: NOW - HOUR + MINUTE }] }),
    );
    expect(view.charts[2]?.chart.domain).toEqual([0, 20]);
  });
});

const reading = (t: number) => ({ cpu: 1, load: 1, memory: 1, t });

describe('the lines', () => {
  test('join points a bucket apart, however wide the buckets', () => {
    const view = vitalsView(
      vitals({
        bucketMs: DAY,
        from: NOW - 3 * DAY,
        points: [reading(NOW - 2 * DAY), reading(NOW - DAY)],
      }),
    );
    expect(view.charts[0]?.chart.points.map(({ value }) => value)).toEqual([1, 1]);
  });

  test('break where more than two buckets went without a reading', () => {
    const view = vitalsView(
      vitals({
        bucketMs: DAY,
        from: NOW - 4 * DAY,
        points: [reading(NOW - 4 * DAY), reading(NOW - DAY)],
      }),
    );
    expect(view.charts[0]?.chart.points.map(({ value }) => value)).toEqual([1, null, 1]);
  });
});
