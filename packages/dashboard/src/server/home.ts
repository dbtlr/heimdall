import { ConditionLevelSchema } from '@heimdall/schema';
import type { SQL } from 'bun';

import { groupChanges } from '../lib/home-changes.ts';
import { pendingPackages } from '../lib/home-maintenance.ts';
import { pickAttention } from '../lib/home.ts';
import type { Attention } from './attention-types.ts';
import { readConditionDetail } from './condition-detail.ts';
import type { SystemGlance } from './fleet-overview-types.ts';
import {
  findGaps,
  inSnapshot,
  readCpuBuckets,
  readGlanceSnapshot,
  toBucket,
} from './fleet-overview.ts';
import type { BucketRow } from './fleet-overview.ts';
import { readHomeAgents } from './home-agents.ts';
import { readChanges, readHomeJobs, readPackageObservations } from './home-cards.ts';
import { CHANGES_SINCE_MS, STOPS_WINDOW_MS, TILE_HISTORY_MS } from './home-types.ts';
import type {
  AvailableUpdate,
  ClearedCondition,
  Home,
  LeadEvidence,
  SystemTiles,
  TileGlance,
} from './home-types.ts';
import { bySystem, conditionKind } from './hub-rows.ts';
import { readServiceStops } from './service-stops.ts';
import { readServiceGlance } from './services.ts';

type Input = { now: number; unpaired: boolean };

// The glance with each System's tile: its CPU over the last day, the gaps in
// it, and its Services; and each Service with an available update. Each part
// is one statement over every System shown, so the count of statements does
// not grow with the fleet. Call it inside a snapshot.
const readTilesAndUpdates = async (
  sql: SQL,
  { now, unpaired }: Input,
): Promise<{ tiles: SystemTiles; updates: AvailableUpdate[] }> => {
  const glance = await readGlanceSnapshot(sql, { now, unpaired });
  const from = now - TILE_HISTORY_MS;
  const names = [...glance.lanes, ...glance.unpairedLanes].map(({ name }) => name);
  const [buckets, services]: [BucketRow[], Awaited<ReturnType<typeof readServiceGlance>>] =
    names.length === 0
      ? [[], { counts: new Map(), updates: [] }]
      : await Promise.all([
          readCpuBuckets(sql, { from, names, to: now }),
          readServiceGlance(sql, now),
        ]);
  const bucketsOf = bySystem(buckets);
  const tileOf = (lane: SystemGlance): TileGlance => {
    const cpu = (bucketsOf.get(lane.name) ?? []).map(toBucket);
    return {
      ...lane,
      cpu,
      gaps: findGaps(
        cpu.map(({ t }) => t),
        { from, now },
      ),
      services: services.counts.get(lane.name) ?? { total: 0, up: 0 },
    };
  };
  return {
    tiles: {
      ...glance,
      from,
      lanes: glance.lanes.map(tileOf),
      unpairedLanes: glance.unpairedLanes.map(tileOf),
    },
    updates: services.updates,
  };
};

const readTilesSnapshot = async (sql: SQL, input: Input): Promise<SystemTiles> =>
  (await readTilesAndUpdates(sql, input)).tiles;

// The evidence Home shows for `lead`: its opened Condition for High CPU and
// High memory, and a down Service's stops over the last week. Undefined for an
// item the Hub holds no Condition for.
const readLeadEvidence = async (
  sql: SQL,
  lead: Attention | undefined,
  now: number,
): Promise<LeadEvidence | undefined> => {
  if (lead?.conditionId === undefined) {
    return undefined;
  }
  const { conditionId, system } = lead;
  if (lead.kind === 'high_cpu' || lead.kind === 'high_memory') {
    const detail = await readConditionDetail(sql, { id: conditionId, name: system, now });
    return { conditionId, detail, stops: undefined };
  }
  if (lead.kind === 'service_down') {
    const stops = await readServiceStops(sql, {
      includeUnpaired: false,
      service: lead.subject,
      since: new Date(now - STOPS_WINDOW_MS),
      system,
    });
    return { conditionId, detail: undefined, stops: stops.length };
  }
  return { conditionId, detail: undefined, stops: undefined };
};

// The Condition on a paired System that cleared last, if any ever did: the
// latest clear the Hub recorded. Walking the transitions newest first by their
// key stops at the first such clear, so the read does not grow with history,
// as an order by `cleared_at`, which no index covers, would.
const readLastCleared = async (sql: SQL): Promise<ClearedCondition | undefined> => {
  const [row]: {
    cleared_at: Date;
    id: string;
    kind: string;
    level: string;
    raised_at: Date;
    subject: string;
    system: string;
  }[] = await sql`
    SELECT c.id::text AS id, c.system, c.kind, c.level, c.subject, c.raised_at, c.cleared_at
    FROM condition_transitions t
    JOIN conditions c ON c.id = t.condition
    JOIN paired_systems p ON p.system = c.system
    WHERE t.action = 'cleared' AND c.cleared_at IS NOT NULL
    ORDER BY t.id DESC
    LIMIT 1
  `;
  return row === undefined
    ? undefined
    : {
        clearedAt: row.cleared_at.getTime(),
        id: row.id,
        kind: conditionKind(row.kind),
        level: ConditionLevelSchema.parse(row.level),
        raisedAt: row.raised_at.getTime(),
        subject: row.subject,
        system: row.system,
      };
};

// Home at `now`: the tiles, the evidence behind the item that needs the
// operator most, and, when nothing does, the Condition that cleared last; what
// the Maintenance, What changed, and Jobs cards say; and, once the viewer's
// time zone is known, agent work in it. Read-only.
const readHomeSnapshot = async (
  sql: SQL,
  input: Input & { timeZone?: string | undefined },
): Promise<Home> => {
  const { tiles, updates } = await readTilesAndUpdates(sql, input);
  const { attention } = tiles;
  const { lead } = pickAttention(attention);
  const { now, timeZone } = input;
  const [evidence, lastCleared, agents, observations, jobs, changes] = await Promise.all([
    readLeadEvidence(sql, lead, now),
    lead === undefined ? readLastCleared(sql) : undefined,
    timeZone === undefined ? undefined : readHomeAgents(sql, { now, timeZone }),
    readPackageObservations(sql),
    readHomeJobs(sql, { attention, now }),
    readChanges(sql, { now, since: now - CHANGES_SINCE_MS }),
  ]);
  return {
    ...tiles,
    agents,
    changes: groupChanges(changes),
    jobs,
    lastCleared,
    lead: evidence,
    maintenance: { packages: pendingPackages(attention, observations), updates },
  };
};

// Each read sees one snapshot, so a tile's status agrees with the evidence
// beside it.
export const readSystemTiles = inSnapshot(readTilesSnapshot);

export const readHome = inSnapshot(readHomeSnapshot);
