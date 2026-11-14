import { expect, test } from 'bun:test';

import { joinStretches, stretchGapMs } from './axis-stretches.ts';

const MIN = 60_000;

const stretch = (harness: string, startedAt: number, endedAt: number) => ({
  endedAt,
  harness,
  startedAt,
});

test('stretches of one Harness closer than the axis can tell apart draw as one bar', () => {
  const gap = stretchGapMs(30 * 24 * 60 * MIN);
  expect(gap).toBe(60 * MIN);
  expect(
    joinStretches(
      [
        stretch('claude-code', 0, 10 * MIN),
        // Overlaps the first, and ends before it.
        stretch('claude-code', 5 * MIN, 8 * MIN),
        stretch('codex', 20 * MIN, 30 * MIN),
        // 60 minutes after the first ends: joined.
        stretch('claude-code', 70 * MIN, 80 * MIN),
        // 61 minutes after: a bar of its own.
        stretch('claude-code', 141 * MIN, 150 * MIN),
      ],
      gap,
    ),
  ).toEqual([
    stretch('claude-code', 0, 80 * MIN),
    stretch('codex', 20 * MIN, 30 * MIN),
    stretch('claude-code', 141 * MIN, 150 * MIN),
  ]);
});
