import { expect, test } from 'bun:test';

import type { ConditionMark } from '../server/fleet-overview-types.ts';
import { cpuSeries, gapLabel, harnessColor, markSpan } from './lane.ts';
import { phraseText } from './phrase.ts';
import type { Phrase } from './phrase.ts';

const MINUTE = 60_000;
const BUCKET = 5 * MINUTE;
const NOW = Date.UTC(2026, 9, 13, 16, 0, 0);

const bucket = (t: number, average = 10) => ({ average, high: average + 5, low: average - 5, t });

test('contiguous buckets make one unbroken run', () => {
  const series = cpuSeries([bucket(0), bucket(BUCKET), bucket(2 * BUCKET)]);
  expect(series.map((point) => point.t)).toEqual([
    BUCKET / 2,
    1.5 * BUCKET,
    2.5 * BUCKET,
    3 * BUCKET,
  ]);
  expect(series.slice(0, 3).every((point) => point.band !== null)).toBe(true);
});

test('a gap between buckets breaks the line', () => {
  const series = cpuSeries([bucket(0, 20), bucket(BUCKET, 30), bucket(4 * BUCKET, 40)]);
  expect(series).toEqual([
    { average: 20, band: [15, 25], t: BUCKET / 2 },
    { average: 30, band: [25, 35], t: 1.5 * BUCKET },
    { average: null, band: null, t: 2 * BUCKET },
    { average: 40, band: [35, 45], t: 4 * BUCKET },
    { average: 40, band: [35, 45], t: 5 * BUCKET },
    { average: null, band: null, t: 5 * BUCKET },
  ]);
});

test('a lone bucket draws across its 5 minutes, since one point draws nothing', () => {
  expect(cpuSeries([bucket(2 * BUCKET, 20)])).toEqual([
    { average: 20, band: [15, 25], t: 2 * BUCKET },
    { average: 20, band: [15, 25], t: 3 * BUCKET },
    { average: null, band: null, t: 3 * BUCKET },
  ]);
});

test('no buckets make no points', () => {
  expect(cpuSeries([])).toEqual([]);
});

test.each([
  [true, 10, 'asleep'],
  [true, 9, undefined],
  [false, 12, undefined],
  [false, 20, 'no Reports'],
] as const)(
  'a gap of %p sleeps spanning %d%% of the window is labeled %p',
  (sleeps, percent, label) => {
    const window = { from: 0, to: 100 };
    expect(gapLabel({ from: 10, to: 10 + percent }, { sleeps, window })).toBe(label);
  },
);

test('a gap is measured where it meets the window', () => {
  const window = { from: 100, to: 200 };
  expect(gapLabel({ from: 0, to: 105 }, { sleeps: true, window })).toBeUndefined();
});

const text = (phrase: Phrase) => phraseText(phrase, 'UTC');

test('a Harness has its color, and an unknown one the neutral one', () => {
  expect(harnessColor('claude-code')).toBe('var(--chart-1)');
  expect(harnessColor('codex')).toBe('var(--chart-2)');
  expect(harnessColor('aider')).toBe('var(--chart-3)');
});

test('a Condition mark spans from raised to cleared, or to now while open', () => {
  const mark: ConditionMark = {
    clearedAt: Date.UTC(2026, 9, 13, 3, 40),
    id: '1',
    kind: 'job_failing',
    level: 'alert',
    raisedAt: Date.UTC(2026, 9, 13, 3, 4),
    subject: 'photos-sync',
    transitions: [],
  };
  expect(text(markSpan(mark, NOW))).toBe('03:04 to 03:40');
  expect(text(markSpan({ ...mark, raisedAt: mark.raisedAt - 24 * 60 * MINUTE }, NOW))).toBe(
    'Mon 03:04 to 03:40',
  );
  expect(text(markSpan({ ...mark, clearedAt: undefined }, NOW))).toBe('03:04 to now');
});
