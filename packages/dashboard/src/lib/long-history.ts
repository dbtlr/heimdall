// What the System page's 30 d and 1 y ranges draw where shorter ranges draw a
// lane per Session and a span per Condition, which a year holds too many of to
// read: cost bars, changes counted per day or week, and one row per Condition
// kind.

import { CONDITION_KIND_NAMES } from '@heimdall/schema';
import type { ConditionKind } from '@heimdall/schema';

import type { ConditionMark, LongRange } from '../server/fleet-overview-types.ts';
import type { ServiceChange } from '../server/home-types.ts';
import type { CostBucket } from '../server/system-detail-types.ts';
import { laneConditions, systemEvents } from './system-events.ts';
import type { Window } from './time.ts';

const DAY_MS = 24 * 60 * 60_000;
// 1970-01-01 was a Thursday, so Mondays fall 4 days after each 7 from it.
const MONDAY_OFFSET_MS = 4 * DAY_MS;

// How wide a bin of the change counts is: a day over 30 d, a Monday-started
// week over a year.
export const CHANGE_BIN_MS: Record<LongRange, number> = { '1y': 7 * DAY_MS, '30d': DAY_MS };

// One bar of the cost chart: its bucket's cost by Harness, Claude Code first,
// and its total.
export type CostBar = {
  parts: { costUsd: number; harness: string }[];
  t: number;
  totalUsd: number;
  unpriced: number;
};

// The cost buckets as bars, one per bucket with any cost, in time order.
export const costBars = (costs: readonly CostBucket[]): CostBar[] => {
  const bars = new Map<number, CostBar>();
  for (const { costUsd, harness, t, unpriced } of costs) {
    let bar = bars.get(t);
    if (bar === undefined) {
      bar = { parts: [], t, totalUsd: 0, unpriced: 0 };
      bars.set(t, bar);
    }
    bar.parts.push({ costUsd, harness });
    bar.totalUsd += costUsd;
    bar.unpriced += unpriced;
  }
  for (const bar of bars.values()) {
    bar.parts.sort((a, b) => a.harness.localeCompare(b.harness));
  }
  return [...bars.values()].toSorted((a, b) => a.t - b.t);
};

// The start of the bin of `binMs` holding `t`: a UTC day, or the UTC week
// from Monday when the bin is a week.
const binStart = (t: number, binMs: number): number => {
  const offset = binMs % (7 * DAY_MS) === 0 ? MONDAY_OFFSET_MS : 0;
  return Math.floor((t - offset) / binMs) * binMs + offset;
};

// How many Service changes fell in each bin of `binMs` in the window, as the
// Conditions and changes lane lists them: a stop that came with a version
// change counts with it, once.
export const changeCounts = (
  detail: {
    changes: readonly ServiceChange[];
    conditions: readonly ConditionMark[];
    paired: boolean;
  },
  window: Window,
  binMs: number,
): { count: number; t: number }[] => {
  const counts = new Map<number, number>();
  for (const event of systemEvents(detail, window)) {
    if (event.kind === 'change') {
      const t = binStart(event.at, binMs);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts].map(([t, count]) => ({ count, t })).toSorted((a, b) => a.t - b.t);
};

// One row of the folded Conditions lane: a kind, its name, and its Conditions
// open in the window, earliest first.
export type KindRow = { count: number; kind: ConditionKind; marks: ConditionMark[]; name: string };

// The Conditions the lane shows, one row per kind, the kind raised most
// often first, then by name.
export const kindRows = (
  conditions: readonly ConditionMark[],
  { paired, window }: { paired: boolean; window: Window },
): KindRow[] => {
  const rows = new Map<ConditionKind, ConditionMark[]>();
  for (const mark of laneConditions(conditions, { paired, window })) {
    rows.set(mark.kind, [...(rows.get(mark.kind) ?? []), mark]);
  }
  return [...rows]
    .map(([kind, marks]): KindRow => ({
      count: marks.length,
      kind,
      marks: marks.toSorted((a, b) => a.raisedAt - b.raisedAt),
      name: CONDITION_KIND_NAMES[kind],
    }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};
