// The data the Fleet overview renders: every paired System as a lane on one
// time axis, the unpaired Systems when asked for, and what needs the operator now.
// Times are epoch milliseconds.

import type { ConditionKind, ConditionLevel, ConditionTransition } from '@heimdall/schema';

import type { Attention } from './attention-types.ts';
import type { Disk } from './system-detail-types.ts';

export const RANGES = ['6h', '12h', '24h', '7d'] as const;
export type Range = (typeof RANGES)[number];

export const isRange = (value: unknown): value is Range => RANGES.some((range) => range === value);

// A System not heard from for longer than this is quiet: asleep, if it sleeps,
// and its newest Vitals are no longer shown as current.
export const QUIET_AFTER_MS = 2 * 60_000;

// How old a run of failed alert deliveries must be before the Fleet page says
// delivery is failing, so one refused send that the next pass fixes shows nothing.
export const DELIVERY_FAILING_SHOWN_AFTER_MS = 10 * 60_000;

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

// A Condition raised or cleared within the range; either time may fall
// outside it.
export type ConditionMark = {
  clearedAt: number | undefined;
  id: string;
  kind: ConditionKind;
  level: ConditionLevel;
  raisedAt: number;
  subject: string;
  transitions: ConditionTransition[];
};

export type Lane = {
  buckets: CpuBucket[];
  conditions: ConditionMark[];
  gaps: Gap[];
  lastSeenAt: number | undefined;
  // The newest Vitals sample, undefined for a System that never sent one.
  latest:
    | { cpuBusyPercent: number; disks: Disk[]; memoryUsedPercent: number | undefined; t: number }
    | undefined;
  name: string;
  // When the Hub's silence on this System's alerts ends, epoch ms; undefined
  // when none holds. It changes no status, count, or Condition (ADR-0020).
  silencedUntil: number | undefined;
  sleeps: boolean;
  status: LaneStatus;
  stretches: Stretch[];
};

export type FleetOverview = {
  // Everything that needs the operator on the Systems shown, with the evidence
  // behind it: newest first detected first, those on paired Systems first.
  attention: Attention[];
  // When the Hub's current run of failed alert deliveries began, undefined
  // while delivery works or is off. A status of the Hub, not a Condition: it
  // joins no count or list (ADR-0020).
  deliveryFailingSince: number | undefined;
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
