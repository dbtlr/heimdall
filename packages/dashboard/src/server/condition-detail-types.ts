// One Condition occurrence, opened: the facts its page shows. Times are epoch
// milliseconds.

import type { ConditionLevel, ConditionLimitSet, ConditionTransition } from '@heimdall/schema';

import type { Attention } from './attention-types.ts';
import type { ConditionKind } from './fleet-overview-types.ts';

// The culprit's readings over the chart's window, oldest first, by what the
// kind measures: a mount's used and total bytes (5-minute maxima from
// disk_rollups), the System's busy CPU or used memory as a percentage
// (5-minute averages), or one process's CPU in cores (5-minute maxima). A null
// value marks a bucket with no reading. Kinds with nothing to chart have none.
export type ConditionSeries =
  | { kind: 'disk'; points: { t: number; totalBytes: number; usedBytes: number }[] }
  | { kind: 'percent'; points: { t: number; percent: number | null }[] }
  | { kind: 'cores'; points: { cores: number | null; t: number }[] };

// One package a pending_update Condition's source has pending: the versions it
// would move between (null when unknown), whether it is a security update
// (null when unknown), and when the Hub first confirmed a security update.
export type PendingPackage = {
  available: string | null;
  installed: string | null;
  name: string;
  security: boolean | null;
  securitySince: number | null;
};

export type ConditionDetail = {
  // The open item's evidence and next steps, as the System page builds them;
  // undefined once the occurrence has cleared.
  attention: Attention | undefined;
  clearedAt: number | undefined;
  // The chart's window: the 7 days (disk) or 24 hours (other series) ending
  // at the clearing time, or at the read time while open.
  from: number;
  id: string;
  kind: ConditionKind;
  latestAt: number;
  latestReason: string;
  level: ConditionLevel;
  // The limits the Hub stores now for the System: its own row, else the fleet's.
  // They may differ from the ones that set a past level.
  // Undefined when the Hub has stored none, as before it first starts on a
  // version that stores them.
  limits: ConditionLimitSet | undefined;
  // The packages an open pending_update Condition's source has pending, security
  // updates first; undefined for any other Condition and once cleared.
  packages: PendingPackage[] | undefined;
  // The System Collector's platform, such as linux or darwin; undefined
  // before a Collector reports one. It says how the Hub judges memory.
  platform: string | undefined;
  raisedAt: number;
  series: ConditionSeries | undefined;
  subject: string;
  system: string;
  to: number;
  // In recording order.
  transitions: ConditionTransition[];
};
