import { expect, test } from 'bun:test';

import type { CostCell } from '../server/agents-overview-types.ts';
import type { BreakdownRow } from './agents-breakdown.ts';
import { barStacks, chartBuckets, costDomain, OTHERS_KEY } from './agents-chart.ts';

const HOUR = 3_600_000;

test('Today has a bar per local hour since midnight, the current hour included', () => {
  const midnight = Date.UTC(2026, 9, 6, 22); // 7 October 00:00 in Berlin
  const now = midnight + 2.5 * HOUR;
  const { buckets, unit } = chartBuckets('today', midnight, now, 'Europe/Berlin');
  expect(unit).toBe('hour');
  expect(buckets.map(({ start }) => start)).toEqual([
    midnight,
    midnight + HOUR,
    midnight + 2 * HOUR,
  ]);
  expect(buckets.at(-1)?.end).toBe(midnight + 3 * HOUR);
});

test('a day range has a bar per local day from the one the period starts in to today', () => {
  const now = Date.UTC(2026, 9, 7, 12);
  const from = now - 7 * 24 * HOUR;
  const { buckets, unit } = chartBuckets('7d', from, now, 'Europe/Berlin');
  expect(unit).toBe('day');
  expect(buckets).toHaveLength(8);
  expect(buckets[0]?.start).toBe(Date.UTC(2026, 8, 29, 22)); // 30 September 00:00 in Berlin
  expect(buckets.at(-1)).toEqual({
    end: Date.UTC(2026, 9, 7, 22),
    start: Date.UTC(2026, 9, 6, 22),
  });
});

test('the day of a clock change is 25 hours long', () => {
  const now = Date.UTC(2026, 9, 25, 12); // Berlin ends summer time on 25 October
  const { buckets } = chartBuckets('7d', now - 24 * HOUR, now, 'Europe/Berlin');
  const change = buckets.at(-1);
  expect((change?.end ?? 0) - (change?.start ?? 0)).toBe(25 * HOUR);
});

const row = (key: string, color: string): BreakdownRow => ({
  color,
  key,
  name: key,
  percent: 0,
  pricedCostUsd: 0,
  pricing: 'exact',
  requests: 0,
  unpricedRequests: 0,
});

const cell = (overrides: Partial<CostCell>): CostCell => ({
  bucket: 0,
  harness: 'codex',
  model: 'm-a',
  pricedCostUsd: 1,
  project: 'heimdall',
  system: 'server-1',
  unpricedRequests: 0,
  ...overrides,
});

test('a bar stacks its keys in the legend order, and keys without a color merge into others on top', () => {
  const rows = [
    row('api', 'var(--series-1)'),
    row('fleet', 'var(--series-2)'),
    row('tail-1', 'var(--chart-other)'),
    row('tail-2', 'var(--chart-other)'),
  ];
  const stacks = barStacks(
    [
      cell({ pricedCostUsd: 1, project: 'tail-1' }),
      cell({ pricedCostUsd: 2, project: 'fleet' }),
      cell({ pricedCostUsd: 4, project: 'api' }),
      cell({ pricedCostUsd: 8, project: 'tail-2' }),
      cell({ bucket: 1, pricedCostUsd: 0, project: 'api' }),
    ],
    2,
    'project',
    rows,
  );
  expect(stacks[0]?.segments.map(({ key, pricedCostUsd }) => [key, pricedCostUsd])).toEqual([
    ['api', 4],
    ['fleet', 2],
    [OTHERS_KEY, 9],
  ]);
  expect(stacks[0]?.total).toBe(15);
  expect(stacks[1]).toEqual({ segments: [], total: 0 });
});

test('the value scale tops out at a whole step above the costliest bar', () => {
  expect(costDomain(31.5)).toEqual([0, 40]);
  expect(costDomain(8.7)).toEqual([0, 10]);
  expect(costDomain(0)).toEqual([0, 0.02]);
});
