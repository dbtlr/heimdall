// The Agents cost chart: its bars in the viewer's time zone, the stack of each
// bar, and its value scale.

import type {
  AgentsBreakdown,
  AgentsRange,
  CostBucket,
  CostCell,
} from '../server/agents-overview-types.ts';
import { NEUTRAL_COLOR } from './agents-breakdown.ts';
import type { BreakdownRow } from './agents-breakdown.ts';
import { niceDomain } from './chart-scale.ts';
import type { Domain } from './chart-scale.ts';

// The bars for a period from `from` to `now` in `timeZone`: the Today range
// has one per local hour since midnight, the current hour included and still
// partial; the others one per local day, the day `from` falls on first and
// today last. Hours count from the day's first instant, so a clock change
// gives the day 23 or 25 of them.
export const chartBuckets = (
  range: AgentsRange,
  from: number,
  now: number,
  timeZone: string,
): { buckets: CostBucket[]; unit: 'day' | 'hour' } => {
  const at = (ms: number) =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone);
  const buckets: CostBucket[] = [];
  if (range === 'today') {
    for (let start = at(from); start.epochMilliseconds <= now; start = start.add({ hours: 1 })) {
      buckets.push({
        end: start.add({ hours: 1 }).epochMilliseconds,
        start: start.epochMilliseconds,
      });
    }
    return { buckets, unit: 'hour' };
  }
  const startOf = (day: Temporal.PlainDate) =>
    day.toZonedDateTime({ timeZone }).startOfDay().epochMilliseconds;
  const last = at(now).toPlainDate();
  for (
    let day = at(from).toPlainDate();
    Temporal.PlainDate.compare(day, last) <= 0;
    day = day.add({ days: 1 })
  ) {
    buckets.push({ end: startOf(day.add({ days: 1 })), start: startOf(day) });
  }
  return { buckets, unit: 'day' };
};

export type StackSegment = { color: string; key: string; pricedCostUsd: number };
export type BarStack = { segments: StackSegment[]; total: number };

// The key of the segment that holds every key without a color of its own.
export const OTHERS_KEY = '\u0000others';

const keyOf = (by: AgentsBreakdown, cell: CostCell): string =>
  by === 'project' ? cell.project : cell[by];

// Each bar's stack split by `by`, the segments in the legend's order from the
// bottom up, so a key sits at the same height in every bar. Keys with a color
// of their own get a segment each; the rest merge into one "others" segment
// on top.
export const barStacks = (
  cells: readonly CostCell[],
  bucketCount: number,
  by: AgentsBreakdown,
  rows: readonly BreakdownRow[],
): BarStack[] => {
  const order = new Map(rows.map((row, index) => [row.key, index]));
  const colors = new Map(rows.map((row) => [row.key, row.color]));
  const rank = (key: string) => order.get(key) ?? Number.MAX_SAFE_INTEGER;
  return Array.from({ length: bucketCount }, (_, bucket) => {
    const costs = new Map<string, number>();
    for (const cell of cells) {
      if (cell.bucket === bucket && cell.pricedCostUsd > 0) {
        const key = keyOf(by, cell);
        const shown = (colors.get(key) ?? NEUTRAL_COLOR) === NEUTRAL_COLOR ? OTHERS_KEY : key;
        costs.set(shown, (costs.get(shown) ?? 0) + cell.pricedCostUsd);
      }
    }
    const segments = [...costs]
      .map(([key, pricedCostUsd]) => ({
        color: colors.get(key) ?? NEUTRAL_COLOR,
        key,
        pricedCostUsd,
      }))
      .toSorted((a, b) => rank(a.key) - rank(b.key));
    return { segments, total: segments.reduce((sum, segment) => sum + segment.pricedCostUsd, 0) };
  });
};

// The value scale: from $0 to a whole multiple of two steps at or above
// `most`, the step 1, 2, or 5 times a power of ten, so the top, middle, and
// bottom labels are whole amounts. With no cost it runs to $0.02.
export const costDomain = (most: number): Domain => {
  for (let power = 0.01; ; power *= 10) {
    for (const base of [1, 2, 5]) {
      const step = base * power;
      if (2 * step >= most) {
        return niceDomain([0, Math.max(most, step)], step);
      }
    }
  }
};
