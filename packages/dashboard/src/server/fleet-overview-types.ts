// The data the Fleet overview renders: every paired System as a lane on one
// time axis, and the Conditions open now. Times are epoch milliseconds.

export const RANGES = ['6h', '12h', '24h', '7d'] as const;
export type Range = (typeof RANGES)[number];

export const isRange = (value: unknown): value is Range => RANGES.some((range) => range === value);

// How a lane's status word is decided, first match wins: never heard from;
// any open Condition; a System that sleeps and has been silent over 2 minutes;
// otherwise up.
export type LaneStatus = 'never_seen' | 'needs_you' | 'asleep' | 'up';

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

export type OpenCondition = {
  kind: ConditionKind;
  raisedAt: number;
  reason: string;
  subject: string;
  system: string;
};

export type FleetOverview = {
  from: number;
  lanes: Lane[];
  now: number;
  // Open Conditions on paired Systems, newest raised first.
  open: OpenCondition[];
  range: Range;
  // The server's IANA time zone, so the server and the browser format alike.
  timeZone: string;
  to: number;
};
