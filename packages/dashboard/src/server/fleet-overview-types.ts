// The data the fleet pages render: every paired System, the unpaired Systems
// when asked for, and what needs the operator now, which Home's and the
// Systems page's tiles read as a glance; and the ranges a System page shows.
// Times are epoch milliseconds.

import type { ConditionKind, ConditionLevel, ConditionTransition } from '@heimdall/schema';

import type { Attention } from './attention-types.ts';
import type { Disk } from './system-detail-types.ts';

// The System page's ranges. Up to 7 d its charts draw the Hub's 5-minute
// rollups as they are; the long ranges re-bin them into wider buckets, since
// the raw samples behind the inspector are kept only 14 days (ADR-0008).
export const RANGES = ['6h', '12h', '24h', '7d', '30d', '1y'] as const;
export type Range = (typeof RANGES)[number];

export const LONG_RANGES = ['30d', '1y'] as const;
export type LongRange = (typeof LONG_RANGES)[number];

export const isRange = (value: unknown): value is Range => RANGES.some((range) => range === value);

export const isLongRange = (range: Range): range is LongRange =>
  LONG_RANGES.some((long) => long === range);

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
export const RANGE_MS: Record<Range, number> = {
  '12h': DAY_MS / 2,
  '1y': 365 * DAY_MS,
  '24h': DAY_MS,
  '30d': 30 * DAY_MS,
  '6h': DAY_MS / 4,
  '7d': 7 * DAY_MS,
};

// The width of a chart bucket at each range: the Hub's 5-minute rollups up to
// 7 d, then 3 hours over 30 d and a day over a year, so a chart holds at most
// a few hundred buckets. Each width divides a day, so a bucket holds whole
// 5-minute rollups.
export const RANGE_BUCKET_MS: Record<Range, number> = {
  '12h': 5 * 60_000,
  '1y': DAY_MS,
  '24h': 5 * 60_000,
  '30d': 3 * HOUR_MS,
  '6h': 5 * 60_000,
  '7d': 5 * 60_000,
};

// How long the Hub keeps raw Vitals samples, with the processes and memory
// holders they carry, and raw Harness process readings (ADR-0008).
export const RAW_KEPT_MS = 14 * DAY_MS;

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

// What a Fleet tile draws of one System: its status, its newest Vitals, and
// its silence, none of its history over a range.
export type SystemGlance = {
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
};

export type FleetGlance<L extends SystemGlance = SystemGlance> = {
  // Everything that needs the operator on the Systems shown, with the evidence
  // behind it: newest first detected first, those on paired Systems first.
  attention: Attention[];
  // When the Hub's current run of failed alert deliveries began, undefined
  // while delivery works or is off. A status of the Hub, not a Condition: it
  // joins no count or list (ADR-0020).
  deliveryFailingSince: number | undefined;
  lanes: L[];
  now: number;
  // How many Systems the Hub holds that are no longer paired, asked for or not.
  unpairedCount: number;
  // The unpaired Systems' lanes, empty unless they were asked for.
  unpairedLanes: L[];
};
