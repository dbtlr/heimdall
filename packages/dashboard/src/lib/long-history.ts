// What the System page's 30 d and 1 y ranges draw where shorter ranges draw a
// lane per Session and a span per Condition, which a year holds too many of to
// read: cost bars, changes counted per day or week, and one row per Condition
// kind.

import { CONDITION_KIND_NAMES } from '@heimdall/schema';
import type { ConditionKind } from '@heimdall/schema';

import type { ConditionMark } from '../server/fleet-overview-types.ts';
import type { ServiceChange } from '../server/home-types.ts';
import type { CostBucket, ProcessSeries } from '../server/system-detail-types.ts';
import { spanHolding } from './bucket-edges.ts';
import { laneConditions, systemEvents } from './system-events.ts';
import { xPercent } from './time.ts';
import type { Window } from './time.ts';

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

// How many Service changes fell in each bin of `edges` in the window, local
// days or weeks from Monday (see LongEdges), as the Conditions and changes
// lane lists them: a stop that came with a version change counts with it,
// once. Each count names its bin's start and end.
export const changeCounts = (
  detail: {
    changes: readonly ServiceChange[];
    conditions: readonly ConditionMark[];
    paired: boolean;
  },
  window: Window,
  edges: readonly number[],
): { count: number; end: number; t: number }[] => {
  const counts = new Map<number, { count: number; end: number; t: number }>();
  for (const event of systemEvents(detail, window)) {
    const bin = event.kind === 'change' ? spanHolding(edges, event.at) : undefined;
    if (bin !== undefined) {
      const count = counts.get(bin.start) ?? { count: 0, end: bin.end, t: bin.start };
      count.count += 1;
      counts.set(bin.start, count);
    }
  }
  return [...counts.values()].toSorted((a, b) => a.t - b.t);
};

// Where a mark for a bin of a long range sits, in percent along `window`: the
// middle of the bin's part inside it, so today's bin, which runs past now, and
// the first, which starts before the window, both stay on the chart.
export const binMarkPercent = ({ end, t }: { end: number; t: number }, window: Window): number =>
  xPercent((Math.max(t, window.from) + Math.min(end, window.to)) / 2, window);

// The cores a process kept busy, summed over its buckets.
const busy = (process: ProcessSeries) =>
  process.points.reduce((total, { cores }) => total + (cores ?? 0), 0);

// The `shown` Harness processes that kept the most cores busy over the range,
// busiest first, and the rest summed into one series, harness `other` and
// process id 0, so a year of short-lived processes stays a few lines and a
// small payload. A bucket where none of the rest has a reading is null.
export const foldQuietProcesses = (
  processes: readonly ProcessSeries[],
  shown: number,
): ProcessSeries[] => {
  const ranked = processes.toSorted((a, b) => busy(b) - busy(a) || a.processId - b.processId);
  const rest = ranked.slice(shown);
  if (rest.length === 0) {
    return ranked;
  }
  const summed = new Map<number, number | null>();
  for (const { cores, t } of rest.flatMap((process) => process.points)) {
    const before = summed.get(t) ?? null;
    summed.set(t, cores === null ? before : (before ?? 0) + cores);
  }
  return [
    ...ranked.slice(0, shown),
    {
      harness: 'other',
      pid: 0,
      points: [...summed].map(([t, cores]) => ({ cores, t })).toSorted((a, b) => a.t - b.t),
      processId: 0,
      project: `${String(rest.length)} other processes`,
    },
  ];
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
