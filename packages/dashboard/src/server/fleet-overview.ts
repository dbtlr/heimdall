import type { SQL } from 'bun';

import { isRange, QUIET_AFTER_MS, RANGES } from './fleet-overview-types.ts';
import type {
  ConditionKind,
  ConditionMark,
  CpuBucket,
  FleetOverview,
  Gap,
  Lane,
  LaneStatus,
  Link,
  OpenCondition,
  Range,
  Stretch,
} from './fleet-overview-types.ts';

const field = (input: unknown, key: string): unknown =>
  typeof input === 'object' && input !== null ? Reflect.get(input, key) : undefined;

// What an overview request asks for: its `range`, 24h when it names none, and
// whether it wants the unpaired Systems too.
export const parseOverviewInput = (input: unknown): { range: Range; unpaired: boolean } => {
  const asked = field(input, 'range');
  if (asked !== undefined && !isRange(asked)) {
    throw new Error(`The range ${JSON.stringify(asked)} is not one of ${RANGES.join(', ')}.`);
  }
  return { range: asked ?? '24h', unpaired: field(input, 'unpaired') === true };
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

const CONDITION_KINDS: Record<ConditionKind, true> = {
  drift: true,
  job_failing: true,
  job_overdue: true,
  low_disk: true,
  reports_rejected: true,
  service_down: true,
  system_stale: true,
};

const isConditionKind = (kind: string): kind is ConditionKind => kind in CONDITION_KINDS;

export const isLink = (link: string): link is Link =>
  link === 'linked' || link === 'ambiguous' || link === 'unmatched';

export const conditionKind = (kind: string): ConditionKind => {
  if (!isConditionKind(kind)) {
    throw new Error(
      `The Hub holds a Condition of kind ${kind}, which the dashboard does not know.`,
    );
  }
  return kind;
};

// The last directory name of a working directory.
export const projectOf = (cwd: string | null) => cwd?.split('/').findLast((part) => part !== '');

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
  session_id: string;
  source: string;
  started_at: Date;
  system: string;
};

export type ConditionRow = {
  cleared_at: Date | null;
  kind: string;
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
    project: projectOf(row.last_cwd ?? row.first_cwd),
    sessionId: row.session_id,
    startedAt: row.started_at.getTime(),
  };
};

export const toMark = (row: ConditionRow): ConditionMark => ({
  clearedAt: row.cleared_at?.getTime(),
  kind: conditionKind(row.kind),
  raisedAt: row.raised_at.getTime(),
  subject: row.subject,
});

// The stretches of `systems` that overlap `from` to `to`, each with its
// Session's place and cost, by System and start. Stretches name their System
// and a range of `started_at`, which keeps the view cheap (docs/spec.md, the
// insight views); a stretch that started over a day before `from` is left out.
// A Session's totals price every request it made, so each Session is looked up
// once, however many stretches it has; OFFSET 0 keeps that a lookup per
// Session, since PostgreSQL would otherwise total every Session kept.
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
           s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch, t.cost_usd
    FROM (SELECT DISTINCT harness, system, source, session_id FROM st) k
    JOIN insight.sessions s
      ON (s.harness, s.system, s.source, s.session_id)
       = (k.harness, k.system, k.source, k.session_id)
    CROSS JOIN LATERAL (
      SELECT x.cost_usd
      FROM insight.session_totals x
      WHERE (x.harness, x.system, x.source, x.session_id)
          = (k.harness, k.system, k.source, k.session_id)
      OFFSET 0
    ) t
  )
  SELECT st.system, st.harness, st.source, st.session_id, st.started_at, st.ended_at, st.link,
         s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch, s.cost_usd
  FROM st
  JOIN sessions s USING (harness, system, source, session_id)
  ORDER BY st.system, st.started_at
`;

// Groups `rows` by their `system`.
const bySystem = <Row extends { system: string }>(rows: readonly Row[]) => {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    grouped.set(row.system, [...(grouped.get(row.system) ?? []), row]);
  }
  return grouped;
};

// Every paired System as a lane on one time axis, over the `range` that ends
// at `now`, and the Conditions open now. The Systems no longer paired are
// counted, and get lanes and Conditions of their own only when `unpaired`
// asks for them. Read-only.
export const readFleetOverview = async (
  sql: SQL,
  { now, range, unpaired = false }: { now: number; range: Range; unpaired?: boolean },
): Promise<FleetOverview> => {
  const from = now - RANGE_MS[range];
  const [fromAt, toAt] = [new Date(from), new Date(now)];
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
  const systems = held.filter(({ paired }) => paired || unpaired);
  const names = systems.map(({ name }) => name);
  if (names.length === 0) {
    return {
      from,
      lanes: [],
      now,
      open: [],
      range,
      to: now,
      unpairedCount,
      unpairedLanes: [],
    };
  }
  const [buckets, latest, stretches, marks, open]: [
    BucketRow[],
    LatestRow[],
    StretchRow[],
    ConditionRow[],
    ConditionRow[],
  ] = await Promise.all([
    sql`
      SELECT system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max
      FROM vitals_rollups
      WHERE system IN ${sql(names)}
        AND bucket >= date_bin('5 minutes', ${fromAt}::timestamptz, timestamptz '2000-01-01 00:00:00+00')
        AND bucket < ${toAt}
      ORDER BY system, bucket
    `,
    // One newest sample per System, read through the (system, t) key.
    sql`
      SELECT s.name AS system, v.t, v.cpu_busy_percent, v.memory_used_percent
      FROM systems s
      CROSS JOIN LATERAL (
        SELECT t, cpu_busy_percent,
               memory_used_bytes::float8 * 100 / NULLIF(memory_total_bytes, 0) AS memory_used_percent
        FROM vitals_samples
        WHERE system = s.name
        ORDER BY t DESC
        LIMIT 1
      ) v
      WHERE s.name IN ${sql(names)}
    `,
    readStretches(sql, { from, systems: names, to: now }),
    sql`
      SELECT system, kind, subject, raised_at, cleared_at, latest_reason
      FROM conditions
      WHERE system IN ${sql(names)}
        AND (raised_at BETWEEN ${fromAt} AND ${toAt} OR cleared_at BETWEEN ${fromAt} AND ${toAt})
      ORDER BY raised_at
    `,
    sql`
      SELECT system, kind, subject, raised_at, cleared_at, latest_reason
      FROM conditions
      WHERE system IN ${sql(names)} AND cleared_at IS NULL
      ORDER BY raised_at DESC
    `,
  ]);
  const bucketsOf = bySystem(buckets);
  const latestOf = bySystem(latest);
  const stretchesOf = bySystem(stretches);
  const marksOf = bySystem(marks);
  const openOf = bySystem(open);
  const laneOf = (system: SystemRow): Lane => {
    const own = (bucketsOf.get(system.name) ?? []).map(toBucket);
    const newest = latestOf.get(system.name)?.[0];
    const lastSeenAt = system.last_seen_at?.getTime();
    const sleeps = system.sleeps === true;
    return {
      buckets: own,
      conditions: (marksOf.get(system.name) ?? []).map(toMark),
      gaps: findGaps(
        own.map(({ t }) => t),
        { from, now },
      ),
      lastSeenAt,
      latest:
        newest === undefined
          ? undefined
          : {
              cpuBusyPercent: newest.cpu_busy_percent,
              memoryUsedPercent: newest.memory_used_percent ?? 0,
              t: newest.t.getTime(),
            },
      name: system.name,
      sleeps,
      status: laneStatus({
        hasOpenCondition: openOf.has(system.name),
        lastSeenAt,
        now,
        paired: system.paired,
        sleeps,
      }),
      stretches: (stretchesOf.get(system.name) ?? []).map(toStretch),
    };
  };
  const pairedNames = new Set(systems.filter(({ paired }) => paired).map(({ name }) => name));
  const openConditions = open.map((row): OpenCondition => ({
    kind: conditionKind(row.kind),
    raisedAt: row.raised_at.getTime(),
    reason: row.latest_reason,
    subject: row.subject,
    system: row.system,
    unpaired: !pairedNames.has(row.system),
  }));
  return {
    from,
    lanes: systems.filter(({ paired }) => paired).map(laneOf),
    now,
    // The sort is stable, so each group stays newest raised first.
    open: openConditions.toSorted((a, b) => Number(a.unpaired) - Number(b.unpaired)),
    range,
    to: now,
    unpairedCount,
    unpairedLanes: systems.filter(({ paired }) => !paired).map(laneOf),
  };
};
