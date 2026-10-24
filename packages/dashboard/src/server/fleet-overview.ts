import { ConditionLevelSchema } from '@heimdall/schema';
import type { ConditionTransition } from '@heimdall/schema';
import type { SQL } from 'bun';

import type { Attention } from './attention-types.ts';
import { readAttention } from './attention.ts';
import { readConditionTransitions } from './condition-transitions.ts';
import { isRange, QUIET_AFTER_MS, RANGES } from './fleet-overview-types.ts';
import type {
  ConditionMark,
  CpuBucket,
  FleetGlance,
  FleetOverview,
  Gap,
  Lane,
  LaneStatus,
  Link,
  Range,
  Stretch,
  SystemGlance,
} from './fleet-overview-types.ts';
import { bySystem, conditionKind, field } from './hub-rows.ts';
import { readSilencedUntil } from './silences.ts';

// What a glance request asks for: whether it wants the unpaired Systems too.
export const parseGlanceInput = (input: unknown): { unpaired: boolean } => ({
  unpaired: field(input, 'unpaired') === true,
});

// What an overview request asks for: its `range`, 24h when it names none, and
// whether it wants the unpaired Systems too.
export const parseOverviewInput = (input: unknown): { range: Range; unpaired: boolean } => {
  const asked = field(input, 'range');
  if (asked !== undefined && !isRange(asked)) {
    throw new Error(`The range ${JSON.stringify(asked)} is not one of ${RANGES.join(', ')}.`);
  }
  return { range: asked ?? '24h', ...parseGlanceInput(input) };
};

const MINUTE_MS = 60_000;
export const BUCKET_MS = 5 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
export const RANGE_MS: Record<Range, number> = {
  '12h': DAY_MS / 2,
  '24h': DAY_MS,
  '6h': DAY_MS / 4,
  '7d': 7 * DAY_MS,
};

// The start of the 5-minute bucket holding `t`. The Hub aligns buckets to
// 2000-01-01 UTC, a whole number of 5 minutes after the epoch, so the epoch
// aligns them too.
export const bucketStart = (t: number) => Math.floor(t / BUCKET_MS) * BUCKET_MS;

// The runs of 5-minute buckets with no Vitals, from the bucket holding `from`
// up to, not including, the one holding `now`: that one is still filling, so
// it is not missing. `present` holds the start of each bucket the Hub has.
export const findGaps = (
  present: readonly number[],
  { from, now }: { from: number; now: number },
): Gap[] => {
  const have = new Set(present);
  const gaps: Gap[] = [];
  let open: Gap | undefined;
  for (let t = bucketStart(from); t < bucketStart(now); t += BUCKET_MS) {
    if (have.has(t)) {
      open = undefined;
    } else if (open === undefined) {
      open = { from: t, to: t + BUCKET_MS };
      gaps.push(open);
    } else {
      open.to = t + BUCKET_MS;
    }
  }
  return gaps;
};

export const isLink = (link: string): link is Link =>
  link === 'linked' || link === 'ambiguous' || link === 'unmatched';

const lastFolderOf = (path: string | null) => path?.split('/').findLast((part) => part !== '');

// A project's name (ADR-0019): the last folder of the repository a working
// directory belongs to, else of the working directory itself, as when there is
// no repository or it is `/`, which has no folder name.
export const projectOf = (repository: string | null, cwd: string | null) =>
  lastFolderOf(repository) ?? lastFolderOf(cwd);

// A lane's status word, first match wins (see LaneStatus).
export const laneStatus = ({
  hasOpenCondition,
  lastSeenAt,
  now,
  paired,
  sleeps,
}: {
  hasOpenCondition: boolean;
  lastSeenAt: number | undefined;
  now: number;
  paired: boolean;
  sleeps: boolean;
}): LaneStatus => {
  if (!paired) {
    return 'unpaired';
  }
  if (lastSeenAt === undefined) {
    return 'never_seen';
  }
  if (hasOpenCondition) {
    return 'needs_you';
  }
  return sleeps && now - lastSeenAt > QUIET_AFTER_MS ? 'asleep' : 'up';
};

type SystemRow = {
  last_seen_at: Date | null;
  name: string;
  paired: boolean;
  sleeps: boolean | null;
};

export type BucketRow = {
  bucket: Date;
  cpu_busy_max: number;
  cpu_busy_min: number;
  cpu_busy_sum: number;
  samples: number;
  system: string;
};

type LatestRow = {
  cpu_busy_percent: number;
  disks: NonNullable<SystemGlance['latest']>['disks'];
  memory_used_percent: number | null;
  system: string;
  t: Date;
};

export type StretchRow = {
  cost_usd: string | null;
  ended_at: Date;
  first_cwd: string | null;
  first_git_branch: string | null;
  harness: string;
  last_cwd: string | null;
  last_git_branch: string | null;
  link: string;
  repository: string | null;
  session_id: string;
  source: string;
  started_at: Date;
  system: string;
};

export type ConditionRow = {
  cleared_at: Date | null;
  id: string;
  kind: string;
  level: string;
  latest_reason: string;
  raised_at: Date;
  subject: string;
  system: string;
};

export const toBucket = (row: BucketRow): CpuBucket => ({
  average: row.cpu_busy_sum / row.samples,
  high: row.cpu_busy_max,
  low: row.cpu_busy_min,
  t: row.bucket.getTime(),
});

const toStretch = (row: StretchRow): Stretch => {
  if (!isLink(row.link)) {
    throw new Error(
      `The Hub holds a stretch with link ${row.link}, which the dashboard does not know.`,
    );
  }
  return {
    branch: row.last_git_branch ?? row.first_git_branch ?? undefined,
    costUsd: row.cost_usd === null ? undefined : Number(row.cost_usd),
    endedAt: row.ended_at.getTime(),
    harness: row.harness,
    link: row.link,
    project: projectOf(row.repository, row.last_cwd ?? row.first_cwd),
    sessionId: row.session_id,
    startedAt: row.started_at.getTime(),
  };
};

export const toMark = (row: ConditionRow, transitions: ConditionTransition[]): ConditionMark => ({
  clearedAt: row.cleared_at?.getTime(),
  id: row.id,
  kind: conditionKind(row.kind),
  level: ConditionLevelSchema.parse(row.level),
  raisedAt: row.raised_at.getTime(),
  subject: row.subject,
  transitions,
});

// The stretches of `systems` that overlap `from` to `to`, each with its
// Session's place and cost, by System and start. Stretches name their System
// and a range of `started_at`, which keeps the view cheap (docs/spec.md, the
// insight views); a stretch that started over a day before `from` is left out.
// A Session's totals price every request it made, and its repository is a
// lookup of its process, so each Session is looked up once, however many
// stretches it has; OFFSET 0 keeps that a lookup per Session, since PostgreSQL
// would otherwise build every Session kept.
export const readStretches = (
  sql: SQL,
  { from, systems, to }: { from: number; systems: readonly string[]; to: number },
): Promise<StretchRow[]> => sql`
  WITH st AS MATERIALIZED (
    SELECT system, harness, source, session_id, started_at, ended_at, link
    FROM insight.session_stretches
    WHERE system IN ${sql(systems)}
      AND started_at BETWEEN ${new Date(from - DAY_MS)} AND ${new Date(to)}
      AND ended_at >= ${new Date(from)}
  ), sessions AS MATERIALIZED (
    SELECT k.harness, k.system, k.source, k.session_id,
           s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch, s.repository,
           t.cost_usd
    FROM (SELECT DISTINCT harness, system, source, session_id FROM st) k
    CROSS JOIN LATERAL (
      SELECT x.first_cwd, x.last_cwd, x.first_git_branch, x.last_git_branch, x.repository
      FROM insight.sessions x
      WHERE (x.harness, x.system, x.source, x.session_id)
          = (k.harness, k.system, k.source, k.session_id)
      OFFSET 0
    ) s
    CROSS JOIN LATERAL (
      SELECT x.cost_usd
      FROM insight.session_totals x
      WHERE (x.harness, x.system, x.source, x.session_id)
          = (k.harness, k.system, k.source, k.session_id)
      OFFSET 0
    ) t
  )
  SELECT st.system, st.harness, st.source, st.session_id, st.started_at, st.ended_at, st.link,
         s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch, s.repository, s.cost_usd
  FROM st
  JOIN sessions s USING (harness, system, source, session_id)
  ORDER BY st.system, st.started_at
`;

// When the Hub's current run of failed alert deliveries began, none while
// delivery works or is off.
const readDeliveryFailingSince = async (sql: SQL): Promise<number | undefined> => {
  const [row]: { failing_since: Date | null }[] = await sql`
    SELECT failing_since FROM delivery_status
  `;
  return row?.failing_since?.getTime();
};

// Whether the item is a Condition the Hub holds, not one the dashboard raises.
const isHubCondition = ({ kind }: Attention) =>
  kind !== 'file_unreadable' && kind !== 'checks_missing';

// What the Fleet tiles draw of every paired System at `now`, and what needs
// the operator now. The Systems no longer paired are counted, and get a glance
// and attention of their own only when `unpaired` asks for them. Read-only.
const readGlanceSnapshot = async (
  sql: SQL,
  { now, unpaired = false }: { now: number; unpaired?: boolean },
): Promise<FleetGlance> => {
  // A paired System the Hub has not heard from has no `systems` row; an
  // unpaired one keeps its row, and so its history.
  const held: SystemRow[] = await sql`
    SELECT coalesce(p.system, s.name) AS name, s.last_seen_at, s.sleeps,
           p.system IS NOT NULL AS paired
    FROM paired_systems p
    FULL JOIN systems s ON s.name = p.system
    ORDER BY 1
  `;
  const unpairedCount = held.filter(({ paired }) => !paired).length;
  const deliveryFailingSince = await readDeliveryFailingSince(sql);
  const systems = held.filter(({ paired }) => paired || unpaired);
  const names = systems.map(({ name }) => name);
  if (names.length === 0) {
    return {
      attention: [],
      deliveryFailingSince,
      lanes: [],
      now,
      unpairedCount,
      unpairedLanes: [],
    };
  }
  const [latest, attention, silenced]: [LatestRow[], Attention[], Map<string, number>] =
    await Promise.all([
      // One newest sample per System, read through the (system, t) key.
      sql`
        SELECT s.name AS system, v.t, v.cpu_busy_percent, v.memory_used_percent, v.disks
        FROM systems s
        CROSS JOIN LATERAL (
          SELECT t, cpu_busy_percent, disks,
                 memory_used_bytes::float8 * 100 / NULLIF(memory_total_bytes, 0) AS memory_used_percent
          FROM vitals_samples
          WHERE system = s.name
          ORDER BY t DESC
          LIMIT 1
        ) v
        WHERE s.name IN ${sql(names)}
      `,
      readAttention(sql, { now, systems }),
      readSilencedUntil(sql, { now, systems: names }),
    ]);
  const latestOf = bySystem(latest);
  // Notes remain visible without making the System need action. Evidence
  // freshness does not change the level the Hub stored.
  const withOpenCondition = new Set(
    attention
      .filter((item) => isHubCondition(item) && item.level !== 'note')
      .map(({ system }) => system),
  );
  const glanceOf = (system: SystemRow): SystemGlance => {
    const newest = latestOf.get(system.name)?.[0];
    const lastSeenAt = system.last_seen_at?.getTime();
    const sleeps = system.sleeps === true;
    return {
      lastSeenAt,
      latest:
        newest === undefined
          ? undefined
          : {
              cpuBusyPercent: newest.cpu_busy_percent,
              disks: newest.disks,
              memoryUsedPercent: newest.memory_used_percent ?? undefined,
              t: newest.t.getTime(),
            },
      name: system.name,
      silencedUntil: silenced.get(system.name),
      sleeps,
      status: laneStatus({
        hasOpenCondition: withOpenCondition.has(system.name),
        lastSeenAt,
        now,
        paired: system.paired,
        sleeps,
      }),
    };
  };
  return {
    attention,
    deliveryFailingSince,
    lanes: systems.filter(({ paired }) => paired).map(glanceOf),
    now,
    unpairedCount,
    unpairedLanes: systems.filter(({ paired }) => !paired).map(glanceOf),
  };
};

// The glance with every System drawn as a lane on one time axis over the
// `range` that ends at `now`. Read-only.
const readFleetOverviewSnapshot = async (
  sql: SQL,
  { now, range, unpaired = false }: { now: number; range: Range; unpaired?: boolean },
): Promise<FleetOverview> => {
  const glance = await readGlanceSnapshot(sql, { now, unpaired });
  const from = now - RANGE_MS[range];
  const [fromAt, toAt] = [new Date(from), new Date(now)];
  const names = [...glance.lanes, ...glance.unpairedLanes].map(({ name }) => name);
  if (names.length === 0) {
    return { ...glance, from, lanes: [], range, to: now, unpairedLanes: [] };
  }
  const [buckets, stretches, marks]: [BucketRow[], StretchRow[], ConditionRow[]] =
    await Promise.all([
      sql`
        SELECT system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max
        FROM vitals_rollups
        WHERE system IN ${sql(names)}
          AND bucket >= date_bin('5 minutes', ${fromAt}::timestamptz, timestamptz '2000-01-01 00:00:00+00')
          AND bucket < ${toAt}
        ORDER BY system, bucket
      `,
      readStretches(sql, { from, systems: names, to: now }),
      sql`
        SELECT id, system, kind, level, subject, raised_at, cleared_at, latest_reason
        FROM conditions
        WHERE system IN ${sql(names)}
          AND (cleared_at IS NULL OR (raised_at <= ${toAt} AND cleared_at >= ${fromAt}))
        ORDER BY raised_at, id
      `,
    ]);
  const bucketsOf = bySystem(buckets);
  const stretchesOf = bySystem(stretches);
  const marksOf = bySystem(marks);
  const transitions = await readConditionTransitions(sql, marks);
  const laneOf = (system: SystemGlance): Lane => {
    const own = (bucketsOf.get(system.name) ?? []).map(toBucket);
    return {
      ...system,
      buckets: own,
      conditions: (marksOf.get(system.name) ?? []).map((row) =>
        toMark(row, transitions.get(row.id) ?? []),
      ),
      gaps: findGaps(
        own.map(({ t }) => t),
        { from, now },
      ),
      stretches: (stretchesOf.get(system.name) ?? []).map(toStretch),
    };
  };
  return {
    ...glance,
    from,
    lanes: glance.lanes.map(laneOf),
    range,
    to: now,
    unpairedLanes: glance.unpairedLanes.map(laneOf),
  };
};

// Each read sees one snapshot, so a System's status agrees with the attention
// beside it, and current levels with their transitions.
const inSnapshot =
  <I, O>(read: (sql: SQL, input: I) => Promise<O>) =>
  (sql: SQL, input: I) =>
    sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', (tx) => read(tx, input));

export const readFleetGlance = inSnapshot(readGlanceSnapshot);

export const readFleetOverview = inSnapshot(readFleetOverviewSnapshot);
