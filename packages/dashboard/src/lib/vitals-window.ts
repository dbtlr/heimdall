// What a Vitals window says, as plain values the component only renders: the
// span to read around a moment, how wide its averages are and which kept
// readings they come from, and the CPU, memory, and load charts against the
// limits the Hub judges by.

import type { VitalsWindow } from '../server/vitals-window-types.ts';
import { bucketFor } from './bucket-width.ts';
import { niceDomain } from './chart-scale.ts';
import { withGaps } from './condition-detail.ts';
import type { ChartLine, ChartPoint, PlotView } from './condition-detail.ts';
import type { Window } from './time.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// The width of the Hub's rollups.
const ROLLUP_MS = 5 * MINUTE_MS;

// The Vitals shown before and after the moment they surround.
export const AROUND_MS = 30 * MINUTE_MS;

// The Hub keeps raw samples this long (ADR-0008); older Vitals are 5-minute rollups.
export const RAW_RETENTION_MS = 14 * DAY_MS;

// The most averaged points a window draws, however long it is, so its read
// returns no more rows and its charts draw no more points.
export const MAX_POINTS = 180;

// `span` with AROUND_MS either side, ending no later than `now`, and never
// before it starts, as for a span the System's clock put after `now`.
export const aroundSpan = ({ from, to }: Window, now: number): Window => ({
  from: from - AROUND_MS,
  to: Math.max(from, Math.min(now, to + AROUND_MS)),
});

// How a window's Vitals are read: averaged over `bucketMs`, the narrowest width
// that draws the window in at most MAX_POINTS points, from raw samples while the
// window starts within their retention and the width is under a rollup's, else
// from the 5-minute rollups, averaged wider for a long window.
export const vitalsBuckets = (
  { from, to }: Window,
  now: number,
): Pick<VitalsWindow, 'bucketMs' | 'source'> => {
  const widthMs = bucketFor(to - from, MAX_POINTS);
  return from >= now - RAW_RETENTION_MS && widthMs < ROLLUP_MS
    ? { bucketMs: widthMs, source: 'samples' }
    : { bucketMs: Math.max(ROLLUP_MS, widthMs), source: 'rollups' };
};

// "5-minute", "6-hour", or "3-day": a bucket's width as a compound adjective.
const widthWords = (bucketMs: number): string => {
  const minutes = Math.round(bucketMs / MINUTE_MS);
  if (minutes < 60) {
    return `${String(minutes)}-minute`;
  }
  return minutes < 24 * 60 ? `${String(minutes / 60)}-hour` : `${String(minutes / 60 / 24)}-day`;
};

export type VitalsChart = {
  chart: PlotView;
  key: 'cpu' | 'load' | 'memory';
  // "78% max", the highest average shown, or "No reading".
  max: string;
};

export type VitalsView = {
  charts: VitalsChart[];
  // Whether the Hub holds no reading in the window.
  empty: boolean;
  // What each point averages, for the caption: "1-minute averages".
  source: string;
  window: Window;
};

const rounded = (value: number): number => Math.round(value * 100) / 100;

const present = (points: readonly ChartPoint[]): number[] =>
  points.flatMap(({ value }) => (value === null ? [] : [value]));

const maxOf = (points: readonly ChartPoint[], unit: string): string => {
  const values = present(points);
  return values.length === 0 ? 'No reading' : `${String(rounded(Math.max(...values)))}${unit} max`;
};

// The scale's top for load: the highest reading, never under 2, in whole steps.
const loadDomain = (points: readonly ChartPoint[]): [number, number] => {
  const high = Math.max(2, ...present(points));
  const [low, top] = niceDomain([0, high], high > 10 ? 5 : 1);
  return [low, top];
};

// A dashed line at the limit the Hub judges by, when it stores one.
const limitLine = (percent: number | undefined): ChartLine[] =>
  percent === undefined ? [] : [{ label: `${String(percent)}%`, level: 'note', value: percent }];

// The CPU, memory, and load charts of `vitals`, each on its own scale: percent
// from 0 to 100 for the first two, with a line at the Hub's limit, and load
// from 0. A line breaks where more than two buckets went without a reading.
export const vitalsView = (vitals: VitalsWindow): VitalsView => {
  const window = { from: vitals.from, to: vitals.to };
  const series = (read: 'cpu' | 'load' | 'memory'): ChartPoint[] =>
    withGaps(
      vitals.points.map((point) => ({ t: point.t, value: point[read] })),
      vitals.bucketMs,
    );
  const cpu = series('cpu');
  const memory = series('memory');
  const load = series('load');
  return {
    charts: [
      {
        chart: {
          domain: [0, 100],
          label: 'CPU busy',
          lines: limitLine(vitals.limits.cpuPercent),
          points: cpu,
          window,
        },
        key: 'cpu',
        max: maxOf(cpu, '%'),
      },
      {
        chart: {
          domain: [0, 100],
          label: 'Memory used',
          lines: limitLine(vitals.limits.memoryPercent),
          points: memory,
          window,
        },
        key: 'memory',
        max: maxOf(memory, '%'),
      },
      {
        chart: {
          domain: loadDomain(load),
          label: 'Load, 1 minute',
          lines: [],
          points: load,
          window,
        },
        key: 'load',
        max: maxOf(load, ''),
      },
    ],
    empty: vitals.points.length === 0,
    source: `${widthWords(vitals.bucketMs)} averages`,
    window,
  };
};
