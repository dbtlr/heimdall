// What a Vitals window says, as plain values the component only renders: the
// span to read around a moment, which kept readings to read it from, and the
// CPU, memory, and load charts against the limits the Hub judges by.

import type { VitalsWindow } from '../server/vitals-window-types.ts';
import { niceDomain } from './chart-scale.ts';
import { withGaps } from './condition-detail.ts';
import type { ChartLine, ChartPoint, PlotView } from './condition-detail.ts';
import type { Window } from './time.ts';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// The Vitals shown before and after the moment they surround.
export const AROUND_MS = 30 * MINUTE_MS;

// The Hub keeps raw samples this long (ADR-0008); older Vitals are 5-minute rollups.
export const RAW_RETENTION_MS = 14 * DAY_MS;

// A window longer than this reads rollups even while raw samples exist, so the
// rows read follow the window and stay near a few thousand.
export const RAW_SPAN_MS = 6 * 60 * MINUTE_MS;

// `span` with AROUND_MS either side, ending no later than `now`.
export const aroundSpan = ({ from, to }: Window, now: number): Window => ({
  from: from - AROUND_MS,
  to: Math.max(from, Math.min(now, to + AROUND_MS)),
});

// The kept readings a window is read from: raw samples while the window is
// within their retention and short, else 5-minute rollups.
export const vitalsSource = ({ from, to }: Window, now: number): VitalsWindow['source'] =>
  from >= now - RAW_RETENTION_MS && to - from <= RAW_SPAN_MS ? 'samples' : 'rollups';

export type VitalsChart = {
  chart: PlotView;
  key: 'cpu' | 'load' | 'memory';
  // "78% max", the highest reading shown, or "No reading".
  max: string;
};

export type VitalsView = {
  charts: VitalsChart[];
  // Whether the Hub holds no reading in the window.
  empty: boolean;
  // Where the readings come from, for the caption.
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
// from 0 to 100 for the first two, with a line at the Hub's limit, and load from 0.
export const vitalsView = (vitals: VitalsWindow): VitalsView => {
  const window = { from: vitals.from, to: vitals.to };
  const series = (read: 'cpu' | 'load' | 'memory'): ChartPoint[] =>
    withGaps(vitals.points.map((point) => ({ t: point.t, value: point[read] })));
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
    source: vitals.source === 'samples' ? 'Raw samples' : '5-minute averages',
    window,
  };
};
