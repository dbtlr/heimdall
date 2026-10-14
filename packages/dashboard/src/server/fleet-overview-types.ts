// The data the Fleet overview renders: every paired System as a lane on one
// time axis, the unpaired Systems when asked for, and what needs the operator now.
// Times are epoch milliseconds.

import type { Attention } from './attention-types.ts';

export const RANGES = ['6h', '12h', '24h', '7d'] as const;
export type Range = (typeof RANGES)[number];

export const isRange = (value: unknown): value is Range => RANGES.some((range) => range === value);

// A System not heard from for longer than this is quiet: asleep, if it sleeps,
// and its newest Vitals are no longer shown as current.
export const QUIET_AFTER_MS = 2 * 60_000;

// How a lane's status word is decided, first match wins: no longer paired;
// never heard from; any open Condition; a System that sleeps and is quiet;
// otherwise up.
export type LaneStatus = 'unpaired' | 'never_seen' | 'needs_you' | 'asleep' | 'up';

// One 5-minute Vitals rollup bucket, starting at `t`: CPU busy average, low,
// and high, in percent.
export type CpuBucket = { average: number; high: number; low: number; t: number };

// A run of 5-minute buckets with no Vitals, from the start of the first to the
// end of the last.
export type Gap = { from: number; to: number };

export type Link = 'linked' | 'ambiguous' | 'unmatched';

// One stretch of an agent Session, with the facts of its Session for the tooltip.
export type Stretch = {
  branch: string | undefined;
  // The Session's cost at list price, undefined when any request is unpriced.
  costUsd: number | undefined;
  endedAt: number;
  harness: string;
  link: Link;
  // The last directory name of the Session's working directory.
  project: string | undefined;
  sessionId: string;
  startedAt: number;
};

export type ConditionKind =
  | 'drift'
  | 'job_failing'
  | 'job_overdue'
  | 'low_disk'
  | 'reports_rejected'
  | 'service_down'
  | 'system_stale';

// A Condition raised or cleared within the range; either time may fall
// outside it.
export type ConditionMark = {
  clearedAt: number | undefined;
  kind: ConditionKind;
  raisedAt: number;
  subject: string;
};

export type Lane = {
  buckets: CpuBucket[];
  conditions: ConditionMark[];
  gaps: Gap[];
  lastSeenAt: number | undefined;
  // The newest Vitals sample, undefined for a System that never sent one.
  latest: { cpuBusyPercent: number; memoryUsedPercent: number; t: number } | undefined;
  name: string;
  sleeps: boolean;
  status: LaneStatus;
  stretches: Stretch[];
};

export type FleetOverview = {
  // Everything that needs the operator on the Systems shown, with the evidence
  // behind it: newest first detected first, those on paired Systems first.
  attention: Attention[];
  from: number;
  lanes: Lane[];
  now: number;
  range: Range;
  to: number;
  // How many Systems the Hub holds that are no longer paired, asked for or not.
  unpairedCount: number;
  // The unpaired Systems' lanes, empty unless they were asked for.
  unpairedLanes: Lane[];
};
