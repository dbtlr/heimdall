import type { Report, VitalsSample } from '@heimdall/schema';
import type { SQL } from 'bun';

export type StoreResult = { skipped: number; stored: number };

// Text PostgreSQL can store: NUL and lone surrogates, which the Report schema
// allows, become U+FFFD. Refusing them would stall the Collector's queue.
const storable = (text: string) => text.toWellFormed().replaceAll('\0', '\uFFFD');

const storableJson = (value: unknown) =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === 'string' ? storable(v) : v));

// Records a Report received at `receivedAt` (epoch milliseconds): the System is
// seen at that time, and each sample is stored unless the Hub already holds one
// for the same System and time (ADR-0004).
export const storeReport = (
  sql: SQL,
  { receivedAt, report }: { receivedAt: number; report: Report },
): Promise<StoreResult> =>
  sql.begin(async (tx) => {
    const seenAt = new Date(receivedAt);
    await tx`
      INSERT INTO systems (name, last_seen_at, collector_version, collector_platform, collector_arch)
      VALUES (${report.system}, ${seenAt}, ${storable(report.collector.version)},
              ${report.collector.platform}, ${storable(report.collector.arch)})
      ON CONFLICT (name) DO UPDATE SET
        last_seen_at = GREATEST(systems.last_seen_at, excluded.last_seen_at),
        collector_version = excluded.collector_version,
        collector_platform = excluded.collector_platform,
        collector_arch = excluded.collector_arch
    `;
    // The samples travel as one JSON parameter, so a Report of any size is one statement.
    const stored: unknown[] = await tx`
      INSERT INTO vitals_samples (
        system, t, cpu_busy_percent, memory_total_bytes, memory_used_bytes,
        load_1, load_5, load_15, uptime_seconds, disks,
        collector_cpu_percent, collector_rss_bytes
      )
      SELECT
        ${report.system},
        -- Whole days, then the milliseconds left over: interval arithmetic runs
        -- in double precision, which would round a large count of a smaller
        -- unit. A timestamp without time zone keeps a day 24 hours long.
        (timestamp 'epoch'
          + ((s->>'t')::bigint / 86400000) * interval '1 day'
          + ((s->>'t')::bigint % 86400000) * interval '1 millisecond') AT TIME ZONE 'UTC',
        (s->'cpu'->>'busyPercent')::double precision,
        (s->'memory'->>'totalBytes')::bigint,
        (s->'memory'->>'usedBytes')::bigint,
        (s->'load'->>0)::double precision,
        (s->'load'->>1)::double precision,
        (s->'load'->>2)::double precision,
        (s->>'uptimeSeconds')::double precision,
        s->'disks',
        (s->'collector'->>'cpuPercent')::double precision,
        (s->'collector'->>'rssBytes')::bigint
      FROM jsonb_array_elements(${storableJson(report.samples)}::text::jsonb) AS s
      ON CONFLICT (system, t) DO NOTHING
      RETURNING t
    `;
    // A stored Report ends a run of rejections (ADR-0005).
    await tx`
      UPDATE conditions SET cleared_at = GREATEST(raised_at, ${seenAt})
      WHERE system = ${report.system} AND kind = ${REPORTS_REJECTED} AND cleared_at IS NULL
    `;
    return { skipped: report.samples.length - stored.length, stored: stored.length };
  });

// The kinds of Condition the Hub derives. M3 adds Service, Backup Job, Drift,
// and stale-System Conditions to the same Timeline.
export type ConditionKind = 'reports_rejected';

const REPORTS_REJECTED: ConditionKind = 'reports_rejected';

// Records a Report from `system`, identified by its token, that the Hub
// rejected at `receivedAt`: the System is seen, and its Reports-rejected
// Condition is raised, or takes this reason if already open (ADR-0005). The
// System's row lock orders rejections and stores, so the last to arrive wins.
export const recordRejection = (
  sql: SQL,
  { reason, receivedAt, system }: { reason: string; receivedAt: number; system: string },
): Promise<void> =>
  sql.begin(async (tx) => {
    const at = new Date(receivedAt);
    const why = storable(reason);
    await tx`
      INSERT INTO systems (name, last_seen_at) VALUES (${system}, ${at})
      ON CONFLICT (name) DO UPDATE SET
        last_seen_at = GREATEST(systems.last_seen_at, excluded.last_seen_at)
    `;
    await tx`
      INSERT INTO conditions (system, kind, raised_at, raised_reason, latest_at, latest_reason)
      VALUES (${system}, ${REPORTS_REJECTED}, ${at}, ${why}, ${at}, ${why})
      ON CONFLICT (system, kind, subject) WHERE cleared_at IS NULL DO UPDATE SET
        latest_at = excluded.latest_at,
        latest_reason = excluded.latest_reason
    `;
  });

// A Condition that is raised now, with when it was raised and its latest reason.
export type OpenCondition = { kind: ConditionKind; raisedAt: number; reason: string };

// One line of a System's Timeline: a Condition raised, with the reason it was
// raised for, or cleared.
export type TimelineEntry =
  | { at: number; condition: ConditionKind; kind: 'raised'; reason: string }
  | { at: number; condition: ConditionKind; kind: 'cleared' };

// One System as the page shows it: when the Hub last heard from it, its open
// Conditions and its Timeline, newest first, and, once a Report from it is
// stored, the Collector build that sent it and its newest Vitals sample.
export type SystemSummary = {
  conditions: OpenCondition[];
  lastSeenAt: number;
  name: string;
  reported: { collector: Report['collector']; latest: VitalsSample } | undefined;
  timeline: TimelineEntry[];
};

// How many of each System's most recent Conditions its Timeline shows.
export const TIMELINE_CONDITIONS = 10;

type SystemRow = {
  collector_arch: string | null;
  collector_cpu_percent: number;
  collector_platform: Report['collector']['platform'] | null;
  collector_rss_bytes: string;
  collector_version: string | null;
  cpu_busy_percent: number;
  disks: VitalsSample['disks'];
  last_seen_at: Date;
  load_1: number;
  load_5: number;
  load_15: number;
  memory_total_bytes: string;
  memory_used_bytes: string;
  name: string;
  // Null when no sample from the System is stored.
  t: Date | null;
  uptime_seconds: number;
};

type ConditionRow = {
  cleared_at: Date | null;
  kind: ConditionKind;
  raised_at: Date;
  raised_reason: string;
  system: string;
};

type OpenRow = { kind: ConditionKind; latest_reason: string; raised_at: Date; system: string };

// The Collector build and newest sample of a System with a stored Report.
const reportedOf = (row: SystemRow): SystemSummary['reported'] => {
  const { collector_arch: arch, collector_platform: platform, collector_version: version } = row;
  if (row.t === null || arch === null || platform === null || version === null) {
    return undefined;
  }
  return {
    collector: { arch, platform, version },
    latest: {
      collector: {
        cpuPercent: row.collector_cpu_percent,
        rssBytes: Number(row.collector_rss_bytes),
      },
      cpu: { busyPercent: row.cpu_busy_percent },
      disks: row.disks,
      load: [row.load_1, row.load_5, row.load_15],
      memory: {
        totalBytes: Number(row.memory_total_bytes),
        usedBytes: Number(row.memory_used_bytes),
      },
      t: row.t.getTime(),
      uptimeSeconds: row.uptime_seconds,
    },
  };
};

// A Condition's lines on the Timeline, newest first.
const timelineOf = (row: ConditionRow): TimelineEntry[] => {
  const raised: TimelineEntry = {
    at: row.raised_at.getTime(),
    condition: row.kind,
    kind: 'raised',
    reason: row.raised_reason,
  };
  return row.cleared_at === null
    ? [raised]
    : [{ at: row.cleared_at.getTime(), condition: row.kind, kind: 'cleared' }, raised];
};

// Every System the Hub has heard from, by name. One read-only snapshot keeps
// last seen, status, and Timeline consistent with each other.
export const listSystems = (sql: SQL): Promise<SystemSummary[]> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const systems: SystemRow[] = await tx`
      SELECT s.name, s.last_seen_at, s.collector_version, s.collector_platform, s.collector_arch,
             v.t, v.cpu_busy_percent, v.memory_total_bytes, v.memory_used_bytes,
             v.load_1, v.load_5, v.load_15, v.uptime_seconds, v.disks,
             v.collector_cpu_percent, v.collector_rss_bytes
      FROM systems s
      LEFT JOIN LATERAL (
        SELECT * FROM vitals_samples WHERE system = s.name ORDER BY t DESC LIMIT 1
      ) v ON true
      ORDER BY s.name
    `;
    // Status reads every open Condition, however far back the Timeline's cap reaches.
    const open: OpenRow[] = await tx`
      SELECT system, kind, raised_at, latest_reason FROM conditions
      WHERE cleared_at IS NULL
      ORDER BY raised_at, id
    `;
    const recent: ConditionRow[] = await tx`
      SELECT system, kind, raised_at, raised_reason, cleared_at
      FROM (
        SELECT *, row_number() OVER (PARTITION BY system ORDER BY raised_at DESC, id DESC) AS n
        FROM conditions
      ) c
      WHERE n <= ${TIMELINE_CONDITIONS}
      ORDER BY raised_at DESC, id DESC
    `;
    return systems.map((row) => ({
      conditions: open
        .filter((c) => c.system === row.name)
        .map((c) => ({ kind: c.kind, raisedAt: c.raised_at.getTime(), reason: c.latest_reason })),
      lastSeenAt: row.last_seen_at.getTime(),
      name: row.name,
      reported: reportedOf(row),
      // Conditions of different kinds may overlap, so their lines interleave.
      timeline: recent
        .filter((c) => c.system === row.name)
        .flatMap(timelineOf)
        .toSorted((a, b) => b.at - a.at),
    }));
  });
