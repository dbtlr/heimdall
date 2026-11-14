// What Home and the Systems page read: each System's tile with its last day of
// CPU and its Services, and, for Home, the evidence behind the item that needs
// the operator most and the Condition that cleared last. Times are epoch
// milliseconds.

import type { ConditionKind, ConditionLevel } from '@heimdall/schema';

import type { AgentsSession, PeriodTotals } from './agents-overview-types.ts';
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

// One local day's list-price cost, oldest first in HomeAgents.days.
export type DayCost = PeriodTotals & { start: number };

// Agent work as Home's Agents card shows it, in the viewer's time zone, over
// every System, paired or with history kept, as the Agents page counts it.
// `today` is the Agents page's Today total. `days` are the 6 local days before
// today and today, whose amount is `today`'s. `usualByNow` is what the 7 days
// before today usually spent by this time of day (usualByNow), if enough of
// them had requests. `running` holds every running Session, the latest request
// first, each priced over all its requests. `latestRequestAt` is the newest
// request of any Session, read only while none is running: undefined then
// means no Session was ever recorded.
export type HomeAgents = {
  days: DayCost[];
  latestRequestAt: number | undefined;
  running: AgentsSession[];
  timeZone: string;
  today: PeriodTotals;
  usualByNow: number | undefined;
};

// A Service with a newer version available, and since when, when its
// upstream's releases date it.
export type AvailableUpdate = {
  // The version installed, when the Hub holds one.
  installed: string | null;
  name: string;
  since: number | undefined;
  system: string;
  // The upstream the Service's updates come from, such as `github:owner/repo`.
  upstream: string | null;
  version: string;
};

// The packages pending on one System, the security updates among them, and
// the Pending update Condition the System's row links to.
export type PendingPackages = {
  conditionId: string;
  packages: number;
  security: number;
  system: string;
};

// The packages the Hub holds as pending in one package source on a paired
// System, and how many of them are security updates by its latest evidence or
// earlier, the way the source's Pending update Condition page lists them.
export type HeldPackages = {
  installation: string;
  manager: string;
  packages: number;
  security: number;
  system: string;
};

// What Home's Maintenance card reads besides the open Conditions: the packages
// pending on each paired System with an open Pending update, and each Service
// on a paired System with an available update.
export type HomeMaintenance = { packages: PendingPackages[]; updates: AvailableUpdate[] };

// One change Home's What changed card reads, on a paired System: a Service's
// installed version changing, a Service stopping, `ongoing` while it has not
// run again, or a Condition at warning or alert being raised or cleared.
export type Change =
  | { at: number; from: string; kind: 'version'; service: string; system: string; to: string }
  | {
      at: number;
      kind: 'stop';
      // How long it lasted, undefined while under way or when its end is unknown.
      lasted: number | undefined;
      ongoing: boolean;
      // How many times the Service restarted before it ran steadily.
      restarts: number;
      service: string;
      system: string;
    }
  | {
      action: 'cleared' | 'raised';
      at: number;
      condition: ConditionKind;
      conditionId: string;
      kind: 'condition';
      subject: string;
      system: string;
    };

// A change to a Service: a version that replaced another, or a stop.
export type ServiceChange = Extract<Change, { kind: 'stop' | 'version' }>;

// Changes of one kind, about one Service or Condition, with one version
// transition, or stops all ongoing or all over, that fell within CHANGE_WINDOW_MS of the first: `change` is the
// newest, `at` its time, `systems` each System by name, and `stops` how many
// times the Service stopped on each System: the stops a version change folded
// in, or the stops themselves.
export type ChangeGroup = {
  at: number;
  change: Change;
  stops: Record<string, number>;
  systems: string[];
};

// How far apart changes may be and still read as one.
export const CHANGE_WINDOW_MS = 10 * 60_000;

// How far back What changed reaches.
export const CHANGES_SINCE_MS = 24 * 60 * 60_000;

// How a recorded job stands on Home: failing when its latest run failed or Job
// failing is open, overdue when Job overdue is open, ok after a run that
// succeeded, and due when it has never run.
export type JobState = 'due' | 'failing' | 'ok' | 'overdue';

// One recorded job on a paired System. `at` is when the state began: when its
// latest run finished for failing and ok, when Job overdue was raised for
// overdue, and its next scheduled time for due, undefined when none is known.
// `lastRunAt` is when its latest run finished, undefined when it never ran.
export type HomeJob = {
  at: number | undefined;
  lastRunAt: number | undefined;
  name: string;
  state: JobState;
  system: string;
};

// `agents` is undefined until the viewer's time zone is known. `changes` are
// the newest groups of the last CHANGES_SINCE_MS, newest first, and `jobs`
// every recorded job in the order Home lists them.
export type Home = SystemTiles & {
  agents: HomeAgents | undefined;
  changes: ChangeGroup[];
  jobs: HomeJob[];
  lastCleared: ClearedCondition | undefined;
  lead: LeadEvidence | undefined;
  maintenance: HomeMaintenance;
};
