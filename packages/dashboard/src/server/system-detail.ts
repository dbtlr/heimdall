import { nextScheduledTime } from '@heimdall/schema';
import type { ConditionLimitSet } from '@heimdall/schema';
import type { SQL } from 'bun';

import { validZone } from '../lib/agents-search.ts';
import { edgeSpans, longEdges, spanHolding } from '../lib/bucket-edges.ts';
import type { LongEdges } from '../lib/bucket-edges.ts';
import { foldQuietProcesses } from '../lib/long-history.ts';
import { laneConditions } from '../lib/system-events.ts';
import { SYSTEM_ACTIVITY_RANGE } from './activity-types.ts';
import { readActivitySnapshot } from './activity.ts';
import { readCells } from './agents-costs.ts';
import { readAttention } from './attention.ts';
import { readConditionLimits } from './condition-limits.ts';
import { readConditionTransitions } from './condition-transitions.ts';
import { readDiskTrends } from './disk-trends.ts';
import {
  isLongRange,
  isRange,
  RANGE_BUCKET_MS,
  RANGE_MS,
  RANGES,
  RAW_KEPT_MS,
} from './fleet-overview-types.ts';
import type { Link, LongRange, Range } from './fleet-overview-types.ts';
import {
  bucketStart,
  findGaps,
  isLink,
  laneStatus,
  projectOf,
  readStretches,
  toBucket,
  toMark,
} from './fleet-overview.ts';
import type { BucketRow, ConditionRow, StretchRow } from './fleet-overview.ts';
import { readServiceChanges } from './home-cards.ts';
import type { ServiceChange } from './home-types.ts';
import {
  byCheck,
  field,
  filesOf,
  judgedFilesRecords,
  scheduleOf,
  text,
  toRun,
} from './hub-rows.ts';
import type { ChecksRow, RecordRow, RunRow } from './hub-rows.ts';
import { readMemoryHolders } from './memory-holders.ts';
import { readServices } from './services.ts';
import { readSilencedUntil } from './silences.ts';
import type {
  BucketInspection,
  BucketProcess,
  CostBucket,
  Disk,
  DiskTrend,
  FileIssue,
  HarnessInstall,
  ListedService,
  LoadBucket,
  LongHistory,
  MemoryBucket,
  ProcessSeries,
  RecordedApplication,
  RecordedFiles,
  RecordedJob,
  RecordedService,
  SampleInspection,
  SampleProcess,
  SessionRow,
  SystemDetail,
  SystemRecords,
  UnlinkedSession,
} from './system-detail-types.ts';
import { readSystemNavigation } from './system-navigation.ts';

const DAY_MS = 24 * 60 * 60_000;

const systemName = (input: unknown): string => {
  const name = field(input, 'name');
  if (typeof name !== 'string' || name === '') {
    throw new Error('The request names no System.');
  }
  return name;
};

// The System and range a detail request asks for; the page opens on 12 hours.
export const parseDetailInput = (
  input: unknown,
): { name: string; range: Range; timeZone: string | undefined } => {
  const name = systemName(input);
  const asked = field(input, 'range');
  // The viewer's zone, which the long ranges' days follow; a zone no runtime
  // knows reads as none.
  const timeZone = validZone(field(input, 'timeZone'));
  if (asked === undefined) {
    return { name, range: '12h', timeZone };
  }
  if (!isRange(asked)) {
    throw new Error(`The range ${JSON.stringify(asked)} is not one of ${RANGES.join(', ')}.`);
  }
  return { name, range: asked, timeZone };
};

// The System and time, in epoch milliseconds, a sample request asks for; no
// time asks for the newest sample.
export const parseSampleInput = (input: unknown): { at: number | undefined; name: string } => {
  const name = systemName(input);
  const at = field(input, 'at');
  if (at !== undefined && (typeof at !== 'number' || !Number.isFinite(at))) {
    throw new Error(`The time ${JSON.stringify(at)} is not epoch milliseconds.`);
  }
  return { at, name };
};

// The System, long range, and time, in epoch milliseconds, a bucket request
// asks for; no time asks for the newest bucket.
export const parseBucketInput = (
  input: unknown,
): { at: number | undefined; name: string; range: LongRange; timeZone: string | undefined } => {
  const { at, name } = parseSampleInput(input);
  const range = field(input, 'range');
  if (!isRange(range) || !isLongRange(range)) {
    throw new Error(`The range ${JSON.stringify(range)} is not 30d or 1y.`);
  }
  return { at, name, range, timeZone: validZone(field(input, 'timeZone')) };
};

type SystemRow = {
  cpu_cores: number | null;
  collector_arch: string | null;
  collector_platform: string | null;
  collector_version: string | null;
  last_seen_at: Date | null;
  paired: boolean;
  sleeps: boolean | null;
};

type LatestRow = {
  cpu_busy_percent: number;
  disks: Disk[];
  load_1: number;
  load_5: number;
  load_15: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  t: Date;
  uptime_seconds: number;
};

type VitalsRow = BucketRow & {
  load: number;
  load_high: number;
  load_low: number;
  memory_high: number;
  memory_low: number;
  memory_total: number;
  memory_used: number;
};

// A bucket's Vitals from its 5-minute rollups `v`: CPU, memory, and 1-minute
// load averaged over every sample, however the rollups divide them, with the
// lowest and highest.
const VITALS = `
  sum(v.samples)::int AS samples, min(v.cpu_busy_min) AS cpu_busy_min,
  sum(v.cpu_busy_sum) AS cpu_busy_sum, max(v.cpu_busy_max) AS cpu_busy_max,
  min(v.memory_used_min)::float8 AS memory_low,
  (sum(v.memory_used_sum) / sum(v.samples))::float8 AS memory_used,
  max(v.memory_used_max)::float8 AS memory_high,
  max(v.memory_total_max)::float8 AS memory_total,
  min(v.load_1_min) AS load_low, (sum(v.load_1_sum) / sum(v.samples))::float8 AS load,
  max(v.load_1_max) AS load_high
`;

// `edges` as a PostgreSQL array of times, for width_bucket to find the bucket
// each rollup falls in by binary search, as no join by range could.
const edgeArray = (edges: readonly number[]) =>
  `{${edges.map((t) => new Date(t).toISOString()).join(',')}}`;

// System `name`'s 5-minute Vitals rollups from the one holding `from` up to `to`.
const readVitalsRollups = (
  sql: SQL,
  { from, name, to }: { from: number; name: string; to: number },
): Promise<VitalsRow[]> => sql`
  SELECT v.system, v.bucket, ${sql.unsafe(VITALS)}
  FROM vitals_rollups v
  WHERE v.system = ${name} AND v.bucket >= ${new Date(bucketStart(from))} AND v.bucket < ${new Date(to)}
  GROUP BY v.system, v.bucket
  ORDER BY v.bucket
`;

// System `name`'s Vitals up to `to` in the buckets of `edges`, from their
// 5-minute rollups.
const readVitalsBuckets = (
  sql: SQL,
  { edges, name, to }: { edges: readonly number[]; name: string; to: number },
): Promise<VitalsRow[]> => sql`
  WITH e AS (SELECT ${edgeArray(edges)}::timestamptz[] AS edges)
  SELECT v.system, e.edges[width_bucket(v.bucket, e.edges)] AS bucket, ${sql.unsafe(VITALS)}
  FROM vitals_rollups v, e
  WHERE v.system = ${name} AND v.bucket >= ${new Date(edges[0] ?? to)}
    AND v.bucket < ${new Date(Math.min(to, edges.at(-1) ?? to))}
  GROUP BY 1, 2
  ORDER BY 2
`;

// The System's first 5-minute rollup holds a reboot when its smallest uptime
// is under this. Any later one holds a reboot when its smallest uptime is below
// the one before it: however late after the boot the Collector began, uptime
// only falls when the System starts again, and it keeps counting through a
// laptop's sleep.
const BOOTED_WITHIN_S = 300;

// The start of each 5-minute rollup of System `name` from `from` up to `to`
// that holds a reboot.
const readReboots = async (
  sql: SQL,
  { from, name, to }: { from: number; name: string; to: number },
): Promise<number[]> => {
  const fromAt = new Date(from);
  const rows: { bucket: Date }[] = await sql`
    SELECT bucket FROM (
      SELECT bucket, uptime_min,
             coalesce(
               lag(uptime_min) OVER (ORDER BY bucket),
               (SELECT p.uptime_min FROM vitals_rollups p
                WHERE p.system = ${name} AND p.bucket < ${fromAt}
                ORDER BY p.bucket DESC LIMIT 1)
             ) AS before
      FROM vitals_rollups
      WHERE system = ${name} AND bucket >= ${fromAt} AND bucket < ${new Date(to)}
    ) x
    WHERE CASE WHEN before IS NULL THEN uptime_min < ${BOOTED_WITHIN_S} ELSE uptime_min < before END
    ORDER BY bucket
  `;
  return rows.map(({ bucket }) => bucket.getTime());
};

// The list-price cost of System `name`'s requests up to `now` in each bucket
// of `edges`, per Harness, priced as the Agents chart prices a bar (see
// readCells), so a bar here and Agents' bar for the System on that day agree.
const readCostBuckets = async (
  sql: SQL,
  { edges, name, now }: { edges: readonly number[]; name: string; now: number },
): Promise<CostBucket[]> => {
  const spans = edgeSpans(edges);
  const period = { from: new Date(edges[0] ?? now), to: new Date(now) };
  const costs = new Map<string, CostBucket>();
  for (const row of await readCells(sql, period, spans, name)) {
    const t = spans[row.bucket]?.start ?? 0;
    const key = JSON.stringify([t, row.harness]);
    const cost = costs.get(key) ?? { costUsd: 0, harness: row.harness, t, unpriced: 0 };
    cost.costUsd += row.priced_cost_usd;
    cost.unpriced += row.unpriced_requests;
    costs.set(key, cost);
  }
  return [...costs.values()].toSorted((a, b) => a.t - b.t || a.harness.localeCompare(b.harness));
};

// How many Sessions of System `name` worked, by a stretch of their requests,
// between `from` and `to`.
const countSessions = async (
  sql: SQL,
  { from, name, to }: { from: number; name: string; to: number },
): Promise<number> => {
  const [row]: { n: number }[] = await sql`
    SELECT count(DISTINCT (harness, source, session_id))::int AS n
    FROM insight.session_stretches
    WHERE system = ${name} AND started_at < ${new Date(to)} AND ended_at >= ${new Date(from)}
  `;
  return row?.n ?? 0;
};

// What the long ranges draw in place of Session lanes, from the first edge of
// each bucket list, so every chart and count starts at the same day.
const readLongHistory = async (
  sql: SQL,
  { edges, name, now }: { edges: LongEdges; name: string; now: number },
): Promise<LongHistory> => {
  const [costs, sessions, reboots] = await Promise.all([
    readCostBuckets(sql, { edges: edges.days, name, now }),
    countSessions(sql, { from: edges.days[0] ?? now, name, to: now }),
    readReboots(sql, { from: edges.buckets[0] ?? now, name, to: now }),
  ]);
  return { changeEdges: edges.changes, costs, dayEdges: edges.days, reboots, sessions };
};

export type CoresRow = {
  bucket: Date;
  cores: number | null;
  cwd: string | null;
  harness: string;
  pid: number;
  process_id: number;
  repository: string | null;
};

export const linkOf = (link: string): Link => {
  if (!isLink(link)) {
    throw new Error(
      `The Hub holds a stretch with link ${link}, which the dashboard does not know.`,
    );
  }
  return link;
};

// A Session's project and branch: its repository's name, else its last working
// directory's, and its last branch, else its first.
const sessionPlace = (row: {
  first_cwd: string | null;
  first_git_branch: string | null;
  last_cwd: string | null;
  last_git_branch: string | null;
  repository: string | null;
}) => ({
  branch: row.last_git_branch ?? row.first_git_branch ?? undefined,
  project: projectOf(row.repository, row.last_cwd ?? row.first_cwd),
});

// Groups each Harness process's buckets into its series, in order of first bucket.
export const toProcesses = (rows: readonly CoresRow[]): ProcessSeries[] => {
  const series = new Map<number, ProcessSeries>();
  for (const row of rows) {
    let found = series.get(row.process_id);
    if (found === undefined) {
      found = {
        harness: row.harness,
        pid: row.pid,
        points: [],
        processId: row.process_id,
        project: projectOf(row.repository, row.cwd),
      };
      series.set(row.process_id, found);
    }
    found.points.push({ cores: row.cores, t: row.bucket.getTime() });
  }
  return [...series.values()];
};

// Groups stretches into one row per Session, in order of first stretch. The
// Harness's session id is unique only within a source, so the key has both.
const toSessions = (rows: readonly StretchRow[]): SessionRow[] => {
  const sessions = new Map<string, SessionRow>();
  for (const row of rows) {
    const key = `${row.harness}|${row.source}|${row.session_id}`;
    let found = sessions.get(key);
    if (found === undefined) {
      found = {
        ...sessionPlace(row),
        costUsd: row.cost_usd === null ? undefined : Number(row.cost_usd),
        harness: row.harness,
        sessionId: row.session_id,
        source: row.source,
        stretches: [],
      };
      sessions.set(key, found);
    }
    found.stretches.push({
      endedAt: row.ended_at.getTime(),
      link: linkOf(row.link),
      startedAt: row.started_at.getTime(),
    });
  }
  return [...sessions.values()];
};

// The cores each Harness process of System `name` kept busy in each bucket of
// `edges` up to `now`, from the 5-minute process rollups: the rise of its
// cumulative CPU time across the bucket over the time the bucket has covered,
// its whole width but for the newest, which ends at `now`. A process that ran
// part of a bucket averages over all of it. The long ranges read only these
// rollups, over the whole range: they are kept a year, where the raw readings
// end at 14 days, and one source per range keeps a bucket from mixing the two.
const readProcessRollups = (
  sql: SQL,
  { edges, name, now }: { edges: readonly number[]; name: string; now: number },
): Promise<CoresRow[]> => {
  const [fromAt, toAt] = [new Date(edges[0] ?? now), new Date(now)];
  return sql`
    WITH e AS (SELECT ${edgeArray(edges)}::timestamptz[] AS edges)
    SELECT process_id, harness, pid, cwd, repository, edges[i] AS bucket,
           CASE WHEN samples > 1
                THEN (cpu_seconds / extract(epoch FROM least(edges[i + 1], ${toAt}) - edges[i]))::float8
           END AS cores
    FROM (
      SELECT p.id::float8 AS process_id, p.harness, p.pid, p.cwd, p.repository,
             min(p.started_at) AS started_at, e.edges, width_bucket(r.bucket, e.edges) AS i,
             sum(r.samples) AS samples,
             (max(r.cpu_micros_max) - min(r.cpu_micros_min)) / 1e6 AS cpu_seconds
      FROM harness_processes p
      JOIN harness_process_rollups r ON r.process = p.id
      CROSS JOIN e
      WHERE p.system = ${name}
        AND p.started_at < ${toAt}
        AND (p.ended_at IS NULL OR p.ended_at >= ${fromAt})
        AND r.bucket >= ${fromAt} AND r.bucket < ${toAt}
        AND r.bucket < ${new Date(edges.at(-1) ?? now)}
      GROUP BY p.id, e.edges, i
    ) x
    ORDER BY started_at, process_id, i
  `;
};

// How many Harness processes the long ranges draw by name, the busiest over
// the range; the rest are summed into one.
const PROCESSES_SHOWN = 8;

// One System over the `range` that ends at `now`: its facts, Vitals, Harness
// processes, Sessions, and Conditions, on one time axis. A System that is no
// longer paired keeps its history and reads as unpaired. Undefined for a name
// that is no System. Over 30 d and 1 y its buckets are local days, or 3 hours
// of the local clock, in `timeZone`, the viewer's. Read-only.
const readSystemDetailSnapshot = async (
  sql: SQL,
  {
    name,
    now,
    range,
    timeZone = 'UTC',
  }: { name: string; now: number; range: Range; timeZone?: string | undefined },
): Promise<SystemDetail | undefined> => {
  const [system]: SystemRow[] = await sql`
    SELECT s.cpu_cores, s.last_seen_at, s.sleeps, s.collector_platform, s.collector_arch, s.collector_version,
           p.system IS NOT NULL AS paired
    FROM paired_systems p
    FULL JOIN systems s ON s.name = p.system
    WHERE coalesce(p.system, s.name) = ${name}
  `;
  if (system === undefined) {
    return undefined;
  }
  const from = now - RANGE_MS[range];
  const [fromAt, toAt] = [new Date(from), new Date(now)];
  const firstBucket = new Date(bucketStart(from));
  const widthMs = RANGE_BUCKET_MS[range];
  const edges = isLongRange(range) ? longEdges(range, from, now, timeZone) : undefined;
  const long = edges !== undefined;
  const [
    installs,
    latest,
    vitals,
    cores,
    stretches,
    marks,
    open,
    silenced,
    changes,
    limits,
    diskTrends,
  ]: [
    { installs: HarnessInstall[] }[],
    LatestRow[],
    VitalsRow[],
    CoresRow[],
    StretchRow[],
    ConditionRow[],
    { n: number }[],
    Map<string, number>,
    ServiceChange[],
    ConditionLimitSet | undefined,
    DiskTrend[],
  ] = await Promise.all([
    sql`SELECT installs FROM harness_installs WHERE system = ${name}`,
    sql`
      SELECT t, cpu_busy_percent, memory_total_bytes::float8 AS memory_total_bytes,
             memory_used_bytes::float8 AS memory_used_bytes, uptime_seconds,
             load_1, load_5, load_15, disks
      FROM vitals_samples WHERE system = ${name}
      ORDER BY t DESC LIMIT 1
    `,
    edges === undefined
      ? readVitalsRollups(sql, { from, name, to: now })
      : readVitalsBuckets(sql, { edges: edges.buckets, name, to: now }),
    edges !== undefined
      ? readProcessRollups(sql, { edges: edges.buckets, name, now })
      : // Cores per bucket from the first and last reading in it: CPU time is
        // cumulative, so its rise over the time between is the cores kept
        // busy. Rollups keep no reading times, and raw readings outlast 7 d.
        sql`
      SELECT p.id::float8 AS process_id, p.harness, p.pid, p.cwd, p.repository, r.bucket,
             CASE WHEN r.last_t > r.first_t
                  THEN ((r.cpu_max - r.cpu_min) / 1e6 / extract(epoch FROM r.last_t - r.first_t))::float8
             END AS cores
      FROM harness_processes p
      CROSS JOIN LATERAL (
        SELECT date_bin('5 minutes', x.t, timestamptz '2000-01-01 00:00:00+00') AS bucket,
               min(x.t) AS first_t, max(x.t) AS last_t,
               min(x.cpu_micros) AS cpu_min, max(x.cpu_micros) AS cpu_max
        FROM harness_process_samples x
        WHERE x.process = p.id AND x.t >= ${firstBucket} AND x.t < ${toAt}
        GROUP BY 1
      ) r
      WHERE p.system = ${name}
        AND p.started_at < ${toAt}
        AND (p.ended_at IS NULL OR p.ended_at >= ${firstBucket})
      ORDER BY p.started_at, p.id, r.bucket
    `,
    long ? [] : readStretches(sql, { from, systems: [name], to: now }),
    sql`
      SELECT id, system, kind, level, subject, raised_at, cleared_at, latest_reason
      FROM conditions
      WHERE system = ${name}
        AND (cleared_at IS NULL OR (raised_at <= ${toAt} AND cleared_at >= ${fromAt}))
      ORDER BY raised_at, id
    `,
    sql`SELECT count(*)::int AS n FROM conditions WHERE system = ${name} AND cleared_at IS NULL AND level <> 'note'`,
    readSilencedUntil(sql, { now, systems: [name] }),
    readServiceChanges(sql, { now, since: from, system: name }),
    readConditionLimits(sql, name),
    readDiskTrends(sql, { now, system: name }).then((trends) =>
      trends.map(({ mount, growth, spanMs, sizeChanged }) => ({
        growth,
        mount,
        sizeChanged,
        spanMs,
      })),
    ),
  ]);
  const cpu = vitals.map(toBucket);
  const newest = latest[0];
  const lastSeenAt = system.last_seen_at?.getTime();
  const sleeps = system.sleeps === true;
  const [transitions, longHistory] = await Promise.all([
    readConditionTransitions(sql, marks),
    edges === undefined ? undefined : readLongHistory(sql, { edges, name, now }),
  ]);
  return {
    bucketMs: widthMs,
    changes,
    collectorVersion: system.collector_version ?? undefined,
    conditions: marks.map((row) => toMark(row, transitions.get(row.id) ?? [])),
    cpu,
    cpuCores: system.cpu_cores ?? undefined,
    diskTrends,
    edges: edges?.buckets,
    from,
    gaps: findGaps(
      cpu.map(({ t }) => t),
      { edges: edges?.buckets, from, now },
    ),
    harnesses: installs[0]?.installs
      .map(({ harness, location, version }): HarnessInstall => ({ harness, location, version }))
      .toSorted((a, b) => a.harness.localeCompare(b.harness)),
    lastSeenAt,
    latest:
      newest === undefined
        ? undefined
        : {
            cpuBusyPercent: newest.cpu_busy_percent,
            disks: newest.disks.map(({ mount, totalBytes, usedBytes }) => ({
              mount,
              totalBytes,
              usedBytes,
            })),
            load: [newest.load_1, newest.load_5, newest.load_15],
            memoryTotalBytes: newest.memory_total_bytes,
            memoryUsedBytes: newest.memory_used_bytes,
            t: newest.t.getTime(),
            uptimeSeconds: newest.uptime_seconds,
          },
    limitPercent:
      limits === undefined
        ? undefined
        : {
            cpu: limits.cpu.percent,
            disk: {
              alert: limits.disk.alert,
              note: limits.disk.note,
              warning: limits.disk.warning,
            },
            memory: limits.memory.percent,
          },
    load: vitals.map((row): LoadBucket => ({
      high: row.load_high,
      low: row.load_low,
      t: row.bucket.getTime(),
      value: row.load,
    })),
    long: longHistory,
    memory: vitals.map((row): MemoryBucket => ({
      highBytes: row.memory_high,
      lowBytes: row.memory_low,
      t: row.bucket.getTime(),
      totalBytes: row.memory_total,
      usedBytes: row.memory_used,
    })),
    name,
    now,
    paired: system.paired,
    platform:
      system.collector_platform === null || system.collector_arch === null
        ? undefined
        : { arch: system.collector_arch, os: system.collector_platform },
    processes:
      edges === undefined
        ? toProcesses(cores)
        : foldQuietProcesses(toProcesses(cores), PROCESSES_SHOWN),
    range,
    sessions: toSessions(stretches),
    silencedUntil: silenced.get(name),
    sleeps,
    status: laneStatus({
      hasOpenCondition: (open[0]?.n ?? 0) > 0,
      lastSeenAt,
      now,
      paired: system.paired,
      sleeps,
    }),
    to: now,
  };
};

type SampleRow = {
  cpu_busy_percent: number;
  since: Date;
  load_1: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  t: Date;
};

type SampleProcessRow = {
  cores: number | null;
  cwd: string | null;
  harness: string;
  pid: number;
  process_id: number;
  repository: string | null;
  rss_bytes: number | null;
};

type SampleSessionRow = {
  first_cwd: string | null;
  session_id: string;
  first_git_branch: string | null;
  last_cwd: string | null;
  last_git_branch: string | null;
  process_id: number;
  repository: string | null;
};

type UnlinkedRow = {
  candidates: number;
  first_cwd: string | null;
  first_git_branch: string | null;
  harness: string;
  last_cwd: string | null;
  last_git_branch: string | null;
  link: string;
  repository: string | null;
  session_id: string;
  source: string;
};

type RequestCountRow = {
  harness: string;
  process_id: number | null;
  requests: number;
  session_id: string;
  source: string;
};

// The raw Vitals sample of System `name` nearest `at`, or its newest when `at`
// is undefined, with the Harness processes running then, the Sessions they ran,
// the requests answered in it, and the processes holding the most memory. Undefined when the System has no sample.
// Read-only.
export const readSample = async (
  sql: SQL,
  { at, name }: { at: number | undefined; name: string },
): Promise<SampleInspection | undefined> => {
  const near: { t: Date; uptime_seconds: number }[] =
    at === undefined
      ? await sql`
          SELECT t, uptime_seconds FROM vitals_samples WHERE system = ${name}
          ORDER BY t DESC LIMIT 1
        `
      : await sql`
          SELECT t, uptime_seconds FROM (
            (SELECT t, uptime_seconds FROM vitals_samples
             WHERE system = ${name} AND t <= ${new Date(at)}
             ORDER BY t DESC LIMIT 1)
            UNION ALL
            (SELECT t, uptime_seconds FROM vitals_samples
             WHERE system = ${name} AND t > ${new Date(at)}
             ORDER BY t LIMIT 1)
          ) near
          ORDER BY abs(extract(epoch FROM t - ${new Date(at)}::timestamptz)), t
          LIMIT 1
        `;
  const [nearest] = near;
  if (nearest === undefined) {
    return undefined;
  }
  const { t } = nearest;
  // `since` is the sample before: the sample covers the time after it.
  const [sample]: SampleRow[] = await sql`
    SELECT t, since, cpu_busy_percent, memory_total_bytes::float8 AS memory_total_bytes,
           memory_used_bytes::float8 AS memory_used_bytes, load_1
    FROM insight.vitals WHERE system = ${name} AND t = ${t}
  `;
  if (sample === undefined) {
    return undefined;
  }
  const [buckets, processes, sessions, unlinked, requests, memoryHolders]: [
    BucketRow[],
    SampleProcessRow[],
    SampleSessionRow[],
    UnlinkedRow[],
    RequestCountRow[],
    SampleInspection['memoryHolders'],
  ] = await Promise.all([
    sql`
      SELECT system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max
      FROM vitals_rollups
      WHERE system = ${name}
        AND bucket = date_bin('5 minutes', ${t}::timestamptz, timestamptz '2000-01-01 00:00:00+00')
    `,
    sql`
      SELECT process_id::float8 AS process_id, harness, pid, cwd, repository, cpu_cores AS cores,
             rss_bytes::float8 AS rss_bytes
      FROM insight.vitals_processes
      WHERE system = ${name} AND t = ${t}
      ORDER BY pid, process_id
    `,
    // A process's Sessions: those whose stretch holds the sample, and those it
    // answered requests for in the sample, which takes in the sample after a
    // stretch's last request. Each Session is looked up on its own, and OFFSET 0
    // keeps it so, since PostgreSQL would otherwise build every Session kept to
    // join them. The unlinked stretches below look theirs up the same way.
    sql`
      SELECT x.process_id::float8 AS process_id, x.session_id, s.first_cwd, s.last_cwd,
             s.first_git_branch, s.last_git_branch, s.repository
      FROM (
        SELECT process_id, harness, system, source, session_id
        FROM insight.vitals_sessions WHERE system = ${name} AND t = ${t}
        UNION
        SELECT process_id, harness, system, source, session_id
        FROM insight.vitals_requests
        WHERE system = ${name} AND t = ${t} AND process_id IS NOT NULL
      ) x
      CROSS JOIN LATERAL (
        SELECT y.started_at, y.first_cwd, y.last_cwd, y.first_git_branch, y.last_git_branch,
               y.repository
        FROM insight.sessions y
        WHERE (y.harness, y.system, y.source, y.session_id)
            = (x.harness, x.system, x.source, x.session_id)
        OFFSET 0
      ) s
      ORDER BY x.process_id, s.started_at, x.session_id
    `,
    sql`
      SELECT st.harness, st.source, st.session_id, st.link, st.candidates::int AS candidates,
             s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch, s.repository
      FROM insight.session_stretches st
      CROSS JOIN LATERAL (
        SELECT x.first_cwd, x.last_cwd, x.first_git_branch, x.last_git_branch, x.repository
        FROM insight.sessions x
        WHERE (x.harness, x.system, x.source, x.session_id)
            = (st.harness, st.system, st.source, st.session_id)
        OFFSET 0
      ) s
      WHERE st.system = ${name}
        AND st.started_at BETWEEN ${new Date(t.getTime() - DAY_MS)} AND ${t}
        AND st.ended_at > ${sample.since}
        AND st.link <> 'linked'
      ORDER BY st.started_at
    `,
    sql`
      SELECT process_id::float8 AS process_id, harness, source, session_id,
             count(*)::int AS requests
      FROM insight.vitals_requests
      WHERE system = ${name} AND t = ${t}
      GROUP BY process_id, harness, source, session_id
    `,
    readMemoryHolders(sql, { system: name, t, uptimeSeconds: nearest.uptime_seconds }),
  ]);
  const bucket = buckets[0];
  const sessionsOf = (processId: number) =>
    sessions.filter((row) => row.process_id === processId).map(sessionPlace);
  const answeredBy = (match: (row: RequestCountRow) => boolean) =>
    requests.filter(match).reduce((total, row) => total + row.requests, 0);
  return {
    bucket:
      bucket === undefined
        ? undefined
        : { average: bucket.cpu_busy_sum / bucket.samples, high: bucket.cpu_busy_max },
    cpuBusyPercent: sample.cpu_busy_percent,
    load1: sample.load_1,
    memoryHolders,
    memoryTotalBytes: sample.memory_total_bytes,
    memoryUsedBytes: sample.memory_used_bytes,
    processes: processes.map((row): SampleProcess => ({
      cores: row.cores ?? undefined,
      harness: row.harness,
      pid: row.pid,
      processId: row.process_id,
      project: projectOf(row.repository, row.cwd),
      requests: answeredBy((request) => request.process_id === row.process_id),
      rssBytes: row.rss_bytes ?? undefined,
      sessions: sessionsOf(row.process_id),
    })),
    t: t.getTime(),
    unlinked: unlinked.map((row): UnlinkedSession => {
      const link = linkOf(row.link);
      if (link === 'linked') {
        throw new Error('A linked stretch is not unlinked.');
      }
      const { branch, project } = sessionPlace(row);
      return {
        branch,
        candidates: row.candidates,
        harness: row.harness,
        link,
        project,
        requests: answeredBy(
          (request) =>
            request.process_id === null &&
            request.harness === row.harness &&
            request.source === row.source &&
            request.session_id === row.session_id,
        ),
        sessionId: row.session_id,
      };
    }),
  };
};

type BucketVitalsRow = {
  cpu_average: number | null;
  cpu_high: number | null;
  cpu_low: number | null;
  load_average: number | null;
  load_high: number | null;
  load_low: number | null;
  memory_average: number | null;
  memory_high: number | null;
  memory_low: number | null;
  memory_total: number | null;
  rollups: number;
};

type BucketProcessRow = {
  cpu_hours: number | null;
  cwd: string | null;
  harness: string;
  peak_rss_bytes: number | null;
  pid: number;
  process_id: number;
  repository: string | null;
  sessions: number;
};

const spread = (average: number | null, low: number | null, high: number | null) =>
  average === null || low === null || high === null ? undefined : { average, high, low };

// The bucket of a long `range` that holds `at`, or the newest when `at` is
// undefined, as the inspector shows it: its Vitals from the 5-minute rollups
// in it, any reboot, its agent cost and Sessions, its Harness processes, and
// the Conditions open in it. A pin there never reads a raw sample: past 14
// days the nearest one could be days away. Undefined for a name that is no
// System. Read-only.
export const readBucket = (
  sql: SQL,
  {
    at,
    name,
    now,
    range,
    timeZone = 'UTC',
  }: {
    at: number | undefined;
    name: string;
    now: number;
    range: LongRange;
    timeZone?: string | undefined;
  },
): Promise<BucketInspection | undefined> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const [known]: { paired: boolean; system: boolean }[] = await tx`
      SELECT EXISTS (SELECT 1 FROM systems WHERE name = ${name}) AS system,
             EXISTS (SELECT 1 FROM paired_systems WHERE system = ${name}) AS paired
    `;
    if (known === undefined || (!known.system && !known.paired)) {
      return undefined;
    }
    // The chart's buckets and days, so the inspector reads the bucket drawn.
    const edges = longEdges(range, now - RANGE_MS[range], now, timeZone);
    const first = edges.buckets[0] ?? now;
    const holding = (list: readonly number[]) =>
      spanHolding(list, Math.min(now, Math.max(first, at ?? now))) ?? { end: now, start: now };
    const { end, start: t } = holding(edges.buckets);
    const day = range === '30d' ? holding(edges.days) : undefined;
    const [startAt, endAt] = [new Date(t), new Date(end)];
    const [vitals, reboots, costs, sessions, processes, marks]: [
      BucketVitalsRow[],
      number[],
      Awaited<ReturnType<typeof readCells>>,
      number,
      BucketProcessRow[],
      ConditionRow[],
    ] = await Promise.all([
      tx`
        SELECT count(*)::int AS rollups,
               (sum(cpu_busy_sum) / sum(samples))::float8 AS cpu_average,
               min(cpu_busy_min)::float8 AS cpu_low, max(cpu_busy_max)::float8 AS cpu_high,
               (sum(memory_used_sum) / sum(samples))::float8 AS memory_average,
               min(memory_used_min)::float8 AS memory_low,
               max(memory_used_max)::float8 AS memory_high,
               max(memory_total_max)::float8 AS memory_total,
               (sum(load_1_sum) / sum(samples))::float8 AS load_average,
               min(load_1_min)::float8 AS load_low, max(load_1_max)::float8 AS load_high
        FROM vitals_rollups
        WHERE system = ${name} AND bucket >= ${startAt} AND bucket < ${endAt}
      `,
      readReboots(tx, { from: t, name, to: end }),
      // The bucket's cost, then its day's.
      readCells(
        tx,
        { from: new Date(day?.start ?? t), to: new Date(now) },
        [{ end, start: t }, ...(day === undefined ? [] : [day])],
        name,
      ),
      countSessions(tx, { from: t, name, to: end }),
      tx`
        SELECT p.id::float8 AS process_id, p.harness, p.pid, p.cwd, p.repository,
               CASE WHEN sum(r.samples) > 1
                    THEN ((max(r.cpu_micros_max) - min(r.cpu_micros_min)) / 3.6e9)::float8
               END AS cpu_hours,
               max(r.rss_max)::float8 AS peak_rss_bytes,
               (SELECT count(DISTINCT (s.harness, s.source, s.session_id))::int
                FROM insight.session_stretches s
                WHERE s.system = ${name} AND s.process_id = p.id
                  AND s.started_at < ${endAt} AND s.ended_at >= ${startAt}) AS sessions
        FROM harness_processes p
        LEFT JOIN harness_process_rollups r
          ON r.process = p.id AND r.bucket >= ${startAt} AND r.bucket < ${endAt}
        WHERE p.system = ${name}
          AND p.started_at < ${endAt}
          AND (p.ended_at IS NULL OR p.ended_at >= ${startAt})
        GROUP BY p.id
        ORDER BY cpu_hours DESC NULLS LAST, p.started_at, p.id
      `,
      tx`
        SELECT id, system, kind, level, subject, raised_at, cleared_at, latest_reason
        FROM conditions
        WHERE system = ${name} AND raised_at < ${endAt}
          AND (cleared_at IS NULL OR cleared_at >= ${startAt})
        ORDER BY raised_at, id
      `,
    ]);
    const row = vitals[0];
    const memory =
      row === undefined ? undefined : spread(row.memory_average, row.memory_low, row.memory_high);
    const costOf = (bucket: number) => {
      const rows = costs.filter((cost) => cost.bucket === bucket);
      return {
        costUsd: rows.reduce((total, cost) => total + cost.priced_cost_usd, 0),
        unpricedRequests: rows.reduce((total, cost) => total + cost.unpriced_requests, 0),
      };
    };
    const transitions = await readConditionTransitions(tx, marks);
    // The Conditions the lane draws, so the inspector names no note the open
    // Conditions leave to Maintenance or Services.
    const conditions = laneConditions(
      marks.map((mark) => toMark(mark, transitions.get(mark.id) ?? [])),
      { paired: known.paired, window: { from: t, to: end - 1 } },
    );
    return {
      bucketMs: RANGE_BUCKET_MS[range],
      conditions: conditions.map(({ kind, level, subject }) => ({ kind, level, subject })),
      ...costOf(0),
      cpu: row === undefined ? undefined : spread(row.cpu_average, row.cpu_low, row.cpu_high),
      day: day === undefined ? undefined : { ...day, ...costOf(1) },
      end,
      load1: row === undefined ? undefined : spread(row.load_average, row.load_low, row.load_high),
      memory:
        memory === undefined || row?.memory_total == null
          ? undefined
          : { ...memory, totalBytes: row.memory_total },
      processes: processes.map((process): BucketProcess => ({
        cpuHours: process.cpu_hours ?? undefined,
        harness: process.harness,
        peakRssBytes: process.peak_rss_bytes ?? undefined,
        pid: process.pid,
        processId: process.process_id,
        project: projectOf(process.repository, process.cwd),
        sessions: process.sessions,
      })),
      rebootedAt: reboots[0],
      rollups: row?.rollups ?? 0,
      samplesPruned: t < now - RAW_KEPT_MS,
      sessions,
      t,
    };
  });

// A recorded Service with the checks on it, the supervisor's first.
export const recordedService = (
  name: string,
  record: Record<string, unknown>,
  checks: NonNullable<ChecksRow['services']>,
): RecordedService => ({
  checks: checks
    .filter((check) => check.service === name)
    .map(({ check, detail, since, state }) => ({ check, detail, since, state }))
    .toSorted(byCheck),
  name,
  supervisor: text(record.supervisor) ?? 'none',
});

const isJobCondition = (kind: string): kind is RecordedJob['open'][number] =>
  kind === 'job_failing' || kind === 'job_overdue';

// What System `name`'s provisioner recorded, with the latest checks and runs,
// and the job Conditions open on it. Read-only.
const readSystemRecordsSnapshot = async (
  sql: SQL,
  { name, now }: { name: string; now: number },
): Promise<SystemRecords> => {
  const [records, checks, runs, openJobConditions, zones]: [
    RecordRow[],
    ChecksRow[],
    RunRow[],
    { kind: string; subject: string }[],
    { time_zone: string | null }[],
  ] = await Promise.all([
    sql`SELECT kind, name, record FROM mirrored_records WHERE system = ${name} ORDER BY kind, name`,
    sql`SELECT services, files, file_records FROM check_sets WHERE system = ${name}`,
    sql`SELECT job, latest_run FROM mirrored_runs WHERE system = ${name}`,
    sql`
      SELECT kind, subject FROM conditions
      WHERE system = ${name} AND cleared_at IS NULL AND kind IN ('job_failing', 'job_overdue')
    `,
    sql`SELECT time_zone FROM systems WHERE name = ${name}`,
  ]);
  const timeZone = zones[0]?.time_zone ?? undefined;
  // The Services page's own reader, for this System alone, so one rule says
  // what counts as an available update.
  const installedOf = new Map(
    (await readServices(sql, now, name)).map((service) => [service.name, service]),
  );
  const of = (kind: string) => records.filter((row) => row.kind === kind);
  const serviceChecks = checks[0]?.services ?? [];
  const fileChecks = checks[0]?.files ?? [];
  const judged = await judgedFilesRecords(checks[0], records);
  const files = of('files').map(({ name: record, record: body }): RecordedFiles => {
    const checked = judged.has(record);
    return {
      checked,
      count: filesOf(body.files).length,
      issues: checked
        ? fileChecks
            .filter((check) => check.record === record)
            .map(({ path, since, state }): FileIssue => ({ path, since, state }))
        : [],
      name: record,
    };
  });
  const runOf = new Map(runs.map((row) => [row.job, toRun(row.latest_run)]));
  return {
    recorded: {
      applications: of('application').map(({ name: app, record }): RecordedApplication => {
        const by = text(field(record.provenance, 'by'));
        return {
          name: app,
          provenance:
            by === undefined
              ? undefined
              : { by, revision: text(field(record.provenance, 'revision')) },
          source: text(record.source),
          version: text(record.version) ?? '',
        };
      }),
      files,
      jobs: of('job').map(({ name: job, record }): RecordedJob => {
        const schedule = scheduleOf(record.schedule);
        return {
          latestRun: runOf.get(job),
          name: job,
          nextRunAt:
            timeZone === undefined
              ? undefined
              : nextScheduledTime({ after: now, schedule, timeZone }),
          open: openJobConditions
            .filter((row) => row.subject === job)
            .map((row) => row.kind)
            .filter(isJobCondition),
          schedule,
        };
      }),
      services: of('service').map(({ name: service, record }): ListedService => {
        const installed = installedOf.get(service);
        return Object.assign(recordedService(service, record, serviceChecks), {
          update: installed?.update,
          version: installed?.version ?? null,
        });
      }),
    },
  };
};

// Current levels and their transitions must come from the same snapshot.
export const readSystemDetail = (sql: SQL, input: Parameters<typeof readSystemDetailSnapshot>[1]) =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', (tx) =>
    readSystemDetailSnapshot(tx, input),
  );

export const readSystemRecords = (
  sql: SQL,
  input: Parameters<typeof readSystemRecordsSnapshot>[1],
) =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', (tx) =>
    readSystemRecordsSnapshot(tx, input),
  );

// Health, history, and attention must describe the same committed judgment.
export const readSystemPage = (sql: SQL, input: Parameters<typeof readSystemDetailSnapshot>[1]) =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const detail = await readSystemDetailSnapshot(tx, input);
    if (detail === undefined) {
      return undefined;
    }
    const [records, attention, navigation, activity] = await Promise.all([
      readSystemRecordsSnapshot(tx, input),
      readAttention(tx, {
        now: input.now,
        systems: [{ name: input.name, paired: detail.paired }],
      }),
      readSystemNavigation(tx, input),
      readActivitySnapshot(tx, {
        now: input.now,
        range: SYSTEM_ACTIVITY_RANGE,
        system: input.name,
      }),
    ]);
    return { activity, attention, detail, navigation, records };
  });
