// What Home and the Systems page read: each System's tile with its last day of
// CPU and its Services, and, for Home, the evidence behind the item that needs
// the operator most and the Condition that cleared last. Times are epoch
// milliseconds.

import type { ConditionKind, ConditionLevel } from '@heimdall/schema';

import type { ConditionDetail } from './condition-detail-types.ts';
import type { CpuBucket, FleetGlance, Gap, SystemGlance } from './fleet-overview-types.ts';

// How far back a tile's CPU sparkline reaches.
export const TILE_HISTORY_MS = 24 * 60 * 60_000;

// How far back Home counts a down Service's stops.
export const STOPS_WINDOW_MS = 7 * 24 * 60 * 60_000;

// A System's glance with what its tile draws besides: its CPU rollup buckets
// since `from`, the runs of buckets with no Vitals among them, and how many of
// its Services are up out of all it has.
export type TileGlance = SystemGlance & {
  cpu: CpuBucket[];
  gaps: Gap[];
  services: { total: number; up: number };
};

// The Systems as tiles, each over the day that ends at `now`.
export type SystemTiles = FleetGlance<TileGlance> & { from: number };

// The evidence Home shows for the item that needs the operator most, the one
// `pickAttention` leads with, found by its Condition. `detail` is its opened
// Condition, read for High CPU and High memory for their chart and the
// processes holding the most memory; `stops` counts a down Service's stops
// over STOPS_WINDOW_MS. Each is undefined for the kinds that do not read it.
export type LeadEvidence = {
  conditionId: string;
  detail: ConditionDetail | undefined;
  stops: number | undefined;
};

// The Condition on a paired System that cleared most recently.
export type ClearedCondition = {
  clearedAt: number;
  id: string;
  kind: ConditionKind;
  level: ConditionLevel;
  raisedAt: number;
  subject: string;
  system: string;
};

export type Home = SystemTiles & {
  lastCleared: ClearedCondition | undefined;
  lead: LeadEvidence | undefined;
};
