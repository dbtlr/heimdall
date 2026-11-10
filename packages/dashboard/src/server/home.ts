import { ConditionLevelSchema } from '@heimdall/schema';
import type { SQL } from 'bun';

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
import { STOPS_WINDOW_MS, TILE_HISTORY_MS } from './home-types.ts';
import type {
  ClearedCondition,
  Home,
  LeadEvidence,
  SystemTiles,
  TileGlance,
} from './home-types.ts';
import { bySystem, conditionKind } from './hub-rows.ts';
import { readServiceStops } from './service-stops.ts';
import { readServices } from './services.ts';

type Input = { now: number; unpaired: boolean };

// How many of each System's Services are up, out of all it has.
const serviceCounts = (services: readonly { status: string; system: string }[]) => {
  const counts = new Map<string, { total: number; up: number }>();
  for (const { status, system } of services) {
    const held = counts.get(system) ?? { total: 0, up: 0 };
    counts.set(system, { total: held.total + 1, up: held.up + (status === 'up' ? 1 : 0) });
  }
  return counts;
};

// The glance with each System's tile: its CPU over the last day, the gaps in
// it, and its Services. Each part is one statement over every System shown,
// so the count of statements does not grow with the fleet. Call it inside a
// snapshot.
const readTilesSnapshot = async (sql: SQL, { now, unpaired }: Input): Promise<SystemTiles> => {
  const glance = await readGlanceSnapshot(sql, { now, unpaired });
  const from = now - TILE_HISTORY_MS;
  const names = [...glance.lanes, ...glance.unpairedLanes].map(({ name }) => name);
  const [buckets, services]: [BucketRow[], { status: string; system: string }[]] =
    names.length === 0
      ? [[], []]
      : await Promise.all([readCpuBuckets(sql, { from, names, to: now }), readServices(sql, now)]);
  const bucketsOf = bySystem(buckets);
  const countsOf = serviceCounts(services);
  const tileOf = (lane: SystemGlance): TileGlance => {
    const cpu = (bucketsOf.get(lane.name) ?? []).map(toBucket);
    return {
      ...lane,
      cpu,
      gaps: findGaps(
        cpu.map(({ t }) => t),
        { from, now },
      ),
      services: countsOf.get(lane.name) ?? { total: 0, up: 0 },
    };
  };
  return {
    ...glance,
    from,
    lanes: glance.lanes.map(tileOf),
    unpairedLanes: glance.unpairedLanes.map(tileOf),
  };
};

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

// The Condition on a paired System that cleared last, if any ever did.
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
    FROM conditions c
    JOIN paired_systems p ON p.system = c.system
    WHERE c.cleared_at IS NOT NULL
    ORDER BY c.cleared_at DESC, c.id DESC
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
// operator most, and, when nothing does, the Condition that cleared last.
// Read-only.
const readHomeSnapshot = async (sql: SQL, input: Input): Promise<Home> => {
  const tiles = await readTilesSnapshot(sql, input);
  const { lead } = pickAttention(tiles.attention);
  const [evidence, lastCleared] = await Promise.all([
    readLeadEvidence(sql, lead, input.now),
    lead === undefined ? readLastCleared(sql) : undefined,
  ]);
  return { ...tiles, lastCleared, lead: evidence };
};

// Each read sees one snapshot, so a tile's status agrees with the evidence
// beside it.
export const readSystemTiles = inSnapshot(readTilesSnapshot);

export const readHome = inSnapshot(readHomeSnapshot);
