// What the Activity page reads: every change in a window, flat, before the
// page filters and groups it. Times are epoch milliseconds.

import type { ConditionKind, ConditionLevel } from '@heimdall/schema';

export const ACTIVITY_RANGES = ['24h', '7d', '30d'] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

export const ACTIVITY_RANGE_MS: Record<ActivityRange, number> = {
  '24h': 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export const isActivityRange = (value: unknown): value is ActivityRange =>
  ACTIVITY_RANGES.some((range) => range === value);

// The kinds a viewer filters by. Drift is a Condition kind, listed apart.
export const ACTIVITY_KINDS = ['condition', 'version', 'stop', 'drift', 'alert'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

// A Condition occurrence: `raised` at `at`, or, when it was raised before the
// window, `cleared` at `at`. `clearedAt` is set once it has cleared, and
// `level` is the level it holds, or held when it cleared.
export type ConditionActivity = {
  action: 'cleared' | 'raised';
  at: number;
  clearedAt: number | undefined;
  condition: ConditionKind;
  conditionId: string;
  kind: 'condition' | 'drift';
  level: ConditionLevel;
  reason: string;
  subject: string;
  system: string;
};

// An alert pushed for a Condition, with the time its recovery went out, or
// undefined while it is open or when no recovery was sent.
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
