// What the Activity page reads: every change in a window, flat, before the
// page filters and groups it. Times are epoch milliseconds.

import type { ConditionKind, ConditionLevel } from '@heimdall/schema';

import type { CpuBucket } from './fleet-overview-types.ts';

export const ACTIVITY_RANGES = ['24h', '7d', '30d'] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export const ACTIVITY_RANGE_MS: Record<ActivityRange, number> = {
  '24h': 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

// The range a System's Activity tab shows; the Activity page reaches further.
export const SYSTEM_ACTIVITY_RANGE: ActivityRange = '7d';

export const isActivityRange = (value: unknown): value is ActivityRange =>
  ACTIVITY_RANGES.some((range) => range === value);

// The kinds a viewer filters by. Drift is a Condition kind, listed apart.
export const ACTIVITY_KINDS = ['condition', 'version', 'stop', 'drift', 'alert'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

// A Condition transition: its occurrence `raised`, its level changed from
// `previousLevel`, or `cleared`, at `at`. `level` is the level the transition
// left it at, or held as it cleared, and `reason` the Hub's reason then.
// `open` says whether the occurrence is still open now.
export type ConditionActivity = {
  action: 'cleared' | 'level_changed' | 'raised';
  at: number;
  condition: ConditionKind;
  conditionId: string;
  kind: 'condition' | 'drift';
  level: ConditionLevel;
  open: boolean;
  previousLevel: ConditionLevel | undefined;
  raisedAt: number;
  reason: string;
  subject: string;
  system: string;
};

// An alert pushed for a Condition, with the time its recovered message went
// out, or undefined while it is open or when it closed without one.
export type AlertActivity = {
  at: number;
  condition: ConditionKind;
  kind: 'alert';
  open: boolean;
  recoveredAt: number | undefined;
  subject: string;
  system: string;
};

export type VersionActivity = {
  at: number;
  from: string;
  kind: 'version';
  service: string;
  system: string;
  to: string;
};

export type StopActivity = {
  at: number;
  kind: 'stop';
  ongoing: boolean;
  service: string;
  system: string;
};

export type ActivityEvent = AlertActivity | ConditionActivity | StopActivity | VersionActivity;

// `systems` names every System the events or the Hub's pairings hold, and
// `unpaired` the ones whose history is kept.
export type Activity = {
  events: ActivityEvent[];
  from: number;
  now: number;
  range: ActivityRange;
  systems: string[];
  unpaired: string[];
};

// One run of agent Session stretches of one Harness on a System, drawn on the
// shared axis: stretches closer than the axis can tell apart are drawn as one.
export type AxisStretch = { endedAt: number; harness: string; startedAt: number };

// What the shared axis draws for one System: its CPU busy in the page's
// `bucketMs` buckets, the CPU limit the Hub judges it by, the stretches of its
// Sessions that overlap the range, and whether it is no longer paired.
export type AxisLane = {
  buckets: CpuBucket[];
  cpuLimit: number | undefined;
  stretches: AxisStretch[];
  system: string;
  unpaired: boolean;
};

// What the Activity page reads: the changes, and a lane on the shared axis for
// each System, the paired ones first. `systems` and `unpaired` also name the
// Systems with only Sessions in the range.
export type ActivityPage = Activity & { bucketMs: number; lanes: AxisLane[] };
