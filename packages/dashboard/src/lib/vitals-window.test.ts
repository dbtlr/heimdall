import { describe, expect, test } from 'bun:test';

import type { VitalsWindow } from '../server/vitals-window-types.ts';
import {
  AROUND_MS,
  aroundSpan,
  RAW_RETENTION_MS,
  RAW_SPAN_MS,
  vitalsSource,
  vitalsView,
} from './vitals-window.ts';

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
});

describe('which readings a window is read from', () => {
  test('raw samples within their retention', () => {
    expect(vitalsSource({ from: NOW - HOUR, to: NOW }, NOW)).toBe('samples');
    expect(
      vitalsSource({ from: NOW - RAW_RETENTION_MS, to: NOW - RAW_RETENTION_MS + HOUR }, NOW),
    ).toBe('samples');
  });

  test('rollups once the window starts before the samples are kept', () => {
    expect(
      vitalsSource({ from: NOW - RAW_RETENTION_MS - 1, to: NOW - RAW_RETENTION_MS + HOUR }, NOW),
    ).toBe('rollups');
  });

  test('rollups for a window too long to read raw', () => {
    expect(vitalsSource({ from: NOW - RAW_SPAN_MS, to: NOW }, NOW)).toBe('samples');
    expect(vitalsSource({ from: NOW - RAW_SPAN_MS - 1, to: NOW }, NOW)).toBe('rollups');
  });
});

const vitals = (over: Partial<VitalsWindow> = {}): VitalsWindow => ({
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
    expect(view.source).toBe('Raw samples');
  });

  test('a limit the Hub does not judge by draws no line', () => {
    const view = vitalsView(
      vitals({ limits: { cpuPercent: undefined, memoryPercent: undefined } }),
    );
    expect(view.charts.flatMap(({ chart }) => chart.lines)).toEqual([]);
  });

  test('a window with no reading is empty, and its charts say so', () => {
    const view = vitalsView(vitals({ points: [], source: 'rollups' }));
    expect(view.empty).toBe(true);
    expect(view.charts.map(({ max }) => max)).toEqual(['No reading', 'No reading', 'No reading']);
    expect(view.source).toBe('5-minute averages');
  });

  test('the load scale reaches the highest reading in whole steps', () => {
    const view = vitalsView(
      vitals({ points: [{ cpu: 1, load: 12.2, memory: 1, t: NOW - HOUR + MINUTE }] }),
    );
    expect(view.charts[2]?.chart.domain).toEqual([0, 20]);
  });
});
