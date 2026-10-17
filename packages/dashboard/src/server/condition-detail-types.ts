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
  // The limits the Hub stores for the System: its own row, else the fleet's.
  // Undefined when the Hub has stored none, as before it first starts on a
  // version that stores them.
  limits: ConditionLimitSet | undefined;
  raisedAt: number;
  series: ConditionSeries | undefined;
  subject: string;
  system: string;
  to: number;
  // In recording order.
  transitions: ConditionTransition[];
};
