import { filesRecordDigest } from '@heimdall/schema';
import type { SQL } from 'bun';

import { isRange, RANGES } from './fleet-overview-types.ts';
import type { Link, Range } from './fleet-overview-types.ts';
import {
  bucketStart,
  conditionKind,
  findGaps,
  isLink,
  laneStatus,
  projectOf,
  RANGE_MS,
  toBucket,
  toMark,
} from './fleet-overview.ts';
import type { BucketRow, ConditionRow } from './fleet-overview.ts';
import type {
  FileIssue,
  JobRun,
  MemoryBucket,
  ProcessSeries,
  RecordedApplication,
  RecordedFiles,
  RecordedJob,
  RecordedService,
  SampleInspection,
  SampleProcess,
  ScheduleEntry,
  ServiceCheck,
  SessionRow,
  SystemDetail,
  SystemRecords,
  TimelineEntry,
  UnlinkedSession,
} from './system-detail-types.ts';

const DAY_MS = 24 * 60 * 60_000;
// The Timeline covers this much history, and every Condition still open.
const TIMELINE_MS = 7 * DAY_MS;

const field = (input: unknown, key: string): unknown =>
  typeof input === 'object' && input !== null ? Reflect.get(input, key) : undefined;

const systemName = (input: unknown): string => {
  const name = field(input, 'name');
  if (typeof name !== 'string' || name === '') {
    throw new Error('The request names no System.');
  }
  return name;
};

// The System and range a detail request asks for; the page opens on 12 hours.
export const parseDetailInput = (input: unknown): { name: string; range: Range } => {
  const name = systemName(input);
  const asked = field(input, 'range');
  if (asked === undefined) {
    return { name, range: '12h' };
  }
  if (!isRange(asked)) {
    throw new Error(`The range ${JSON.stringify(asked)} is not one of ${RANGES.join(', ')}.`);
  }
  return { name, range: asked };
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

type SystemRow = {
  collector_arch: string | null;
  collector_platform: string | null;
  last_seen_at: Date | null;
  sleeps: boolean | null;
};

type LatestRow = {
  cpu_busy_percent: number;
  memory_total_bytes: number;
  memory_used_bytes: number;
  t: Date;
  uptime_seconds: number;
};

type MemoryRow = { bucket: Date; total: number; used: number };

export type CoresRow = {
  bucket: Date;
  cores: number | null;
  cwd: string | null;
  harness: string;
  pid: number;
  process_id: number;
};

type StretchRow = {
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
};

export const linkOf = (link: string): Link => {
  if (!isLink(link)) {
    throw new Error(
      `The Hub holds a stretch with link ${link}, which the dashboard does not know.`,
    );
  }
  return link;
};

// A Session's project and branch: its last working directory's name and its
// last branch, else its first.
const sessionPlace = (row: {
  first_cwd: string | null;
  first_git_branch: string | null;
  last_cwd: string | null;
  last_git_branch: string | null;
}) => ({
  branch: row.last_git_branch ?? row.first_git_branch ?? undefined,
  project: projectOf(row.last_cwd ?? row.first_cwd),
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
        project: projectOf(row.cwd),
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

// One paired System over the `range` that ends at `now`: its facts, Vitals,
// Harness processes, Sessions, and Conditions, on one time axis. Undefined for
// a System that is not paired. Read-only.
export const readSystemDetail = async (
  sql: SQL,
  { name, now, range, timeZone }: { name: string; now: number; range: Range; timeZone: string },
): Promise<SystemDetail | undefined> => {
  const [system]: SystemRow[] = await sql`
    SELECT s.last_seen_at, s.sleeps, s.collector_platform, s.collector_arch
    FROM paired_systems p
    LEFT JOIN systems s ON s.name = p.system
    WHERE p.system = ${name}
  `;
  if (system === undefined) {
    return undefined;
  }
  const from = now - RANGE_MS[range];
  const [fromAt, toAt] = [new Date(from), new Date(now)];
  const firstBucket = new Date(bucketStart(from));
  const [installs, latest, buckets, memory, cores, stretches, marks, open]: [
    { installs: { harness: string; version: string }[] }[],
    LatestRow[],
    BucketRow[],
    MemoryRow[],
    CoresRow[],
    StretchRow[],
    ConditionRow[],
    { n: number }[],
  ] = await Promise.all([
    sql`SELECT installs FROM harness_installs WHERE system = ${name}`,
    sql`
      SELECT t, cpu_busy_percent, memory_total_bytes::float8 AS memory_total_bytes,
             memory_used_bytes::float8 AS memory_used_bytes, uptime_seconds
      FROM vitals_samples WHERE system = ${name}
      ORDER BY t DESC LIMIT 1
    `,
    sql`
      SELECT system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max
      FROM vitals_rollups
      WHERE system = ${name} AND bucket >= ${firstBucket} AND bucket < ${toAt}
      ORDER BY bucket
    `,
    sql`
      SELECT bucket, (memory_used_sum / samples)::float8 AS used, memory_total_max::float8 AS total
      FROM vitals_rollups
      WHERE system = ${name} AND bucket >= ${firstBucket} AND bucket < ${toAt}
      ORDER BY bucket
    `,
    // Cores per bucket from the first and last reading in it: CPU time is
    // cumulative, so its rise over the time between is the cores kept busy.
    // Rollups keep no reading times, and raw readings outlast the longest range.
    sql`
      SELECT p.id::float8 AS process_id, p.harness, p.pid, p.cwd, r.bucket,
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
    // As on the Fleet overview: stretches by System and a range of
    // `started_at`, and each Session's cost looked up per stretch.
    sql`
      SELECT st.harness, st.source, st.session_id, st.started_at, st.ended_at, st.link,
             s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch, t.cost_usd
      FROM insight.session_stretches st
      JOIN insight.sessions s
        ON (s.harness, s.system, s.source, s.session_id)
         = (st.harness, st.system, st.source, st.session_id)
      -- OFFSET 0 keeps this a lookup per stretch (see fleet-overview.ts).
      CROSS JOIN LATERAL (
        SELECT x.cost_usd
        FROM insight.session_totals x
        WHERE (x.harness, x.system, x.source, x.session_id)
            = (st.harness, st.system, st.source, st.session_id)
        OFFSET 0
      ) t
      WHERE st.system = ${name}
        AND st.started_at BETWEEN ${new Date(from - DAY_MS)} AND ${toAt}
        AND st.ended_at >= ${fromAt}
      ORDER BY st.started_at
    `,
    sql`
      SELECT system, kind, subject, raised_at, cleared_at, latest_reason
      FROM conditions
      WHERE system = ${name} AND raised_at <= ${toAt}
        AND (cleared_at IS NULL OR cleared_at >= ${fromAt})
      ORDER BY raised_at
    `,
    sql`SELECT count(*)::int AS n FROM conditions WHERE system = ${name} AND cleared_at IS NULL`,
  ]);
  const cpu = buckets.map(toBucket);
  const newest = latest[0];
  const lastSeenAt = system.last_seen_at?.getTime();
  const sleeps = system.sleeps === true;
  return {
    conditions: marks.map(toMark),
    cpu,
    from,
    gaps: findGaps(
      cpu.map(({ t }) => t),
      { from, now },
    ),
    harnesses: (installs[0]?.installs ?? [])
      .map(({ harness, version }) => ({ harness, version }))
      .toSorted((a, b) => a.harness.localeCompare(b.harness)),
    lastSeenAt,
    latest:
      newest === undefined
        ? undefined
        : {
            cpuBusyPercent: newest.cpu_busy_percent,
            memoryTotalBytes: newest.memory_total_bytes,
            memoryUsedBytes: newest.memory_used_bytes,
            t: newest.t.getTime(),
            uptimeSeconds: newest.uptime_seconds,
          },
    memory: memory.map((row): MemoryBucket => ({
      t: row.bucket.getTime(),
      totalBytes: row.total,
      usedBytes: row.used,
    })),
    name,
    now,
    platform:
      system.collector_platform === null || system.collector_arch === null
        ? undefined
        : { arch: system.collector_arch, os: system.collector_platform },
    processes: toProcesses(cores),
    range,
    sessions: toSessions(stretches),
    sleeps,
    status: laneStatus({ hasOpenCondition: (open[0]?.n ?? 0) > 0, lastSeenAt, now, sleeps }),
    timeZone,
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
  rss_bytes: number | null;
};

type SampleSessionRow = {
  first_cwd: string | null;
  session_id: string;
  first_git_branch: string | null;
  last_cwd: string | null;
  last_git_branch: string | null;
  process_id: number;
};

type UnlinkedRow = {
  candidates: number;
  first_cwd: string | null;
  first_git_branch: string | null;
  harness: string;
  last_cwd: string | null;
  last_git_branch: string | null;
  link: string;
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
// and the requests answered in it. Undefined when the System has no sample.
// Read-only.
export const readSample = async (
  sql: SQL,
  { at, name }: { at: number | undefined; name: string },
): Promise<SampleInspection | undefined> => {
  const near: { t: Date }[] =
    at === undefined
      ? await sql`SELECT t FROM vitals_samples WHERE system = ${name} ORDER BY t DESC LIMIT 1`
      : await sql`
          SELECT t FROM (
            (SELECT t FROM vitals_samples WHERE system = ${name} AND t <= ${new Date(at)}
             ORDER BY t DESC LIMIT 1)
            UNION ALL
            (SELECT t FROM vitals_samples WHERE system = ${name} AND t > ${new Date(at)}
             ORDER BY t LIMIT 1)
          ) near
          ORDER BY abs(extract(epoch FROM t - ${new Date(at)}::timestamptz)), t
          LIMIT 1
        `;
  const t = near[0]?.t;
  if (t === undefined) {
    return undefined;
  }
  // `since` is the sample before: the sample covers the time after it.
  const [sample]: SampleRow[] = await sql`
    SELECT t, since, cpu_busy_percent, memory_total_bytes::float8 AS memory_total_bytes,
           memory_used_bytes::float8 AS memory_used_bytes, load_1
    FROM insight.vitals WHERE system = ${name} AND t = ${t}
  `;
  if (sample === undefined) {
    return undefined;
  }
  const [buckets, processes, sessions, unlinked, requests]: [
    BucketRow[],
    SampleProcessRow[],
    SampleSessionRow[],
    UnlinkedRow[],
    RequestCountRow[],
  ] = await Promise.all([
    sql`
      SELECT system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max
      FROM vitals_rollups
      WHERE system = ${name}
        AND bucket = date_bin('5 minutes', ${t}::timestamptz, timestamptz '2000-01-01 00:00:00+00')
    `,
    sql`
      SELECT process_id::float8 AS process_id, harness, pid, cwd, cpu_cores AS cores,
             rss_bytes::float8 AS rss_bytes
      FROM insight.vitals_processes
      WHERE system = ${name} AND t = ${t}
      ORDER BY pid, process_id
    `,
    // A process's Sessions: those whose stretch holds the sample, and those it
    // answered requests for in the sample, which takes in the sample after a
    // stretch's last request.
    sql`
      SELECT x.process_id::float8 AS process_id, x.session_id, s.first_cwd, s.last_cwd,
             s.first_git_branch, s.last_git_branch
      FROM (
        SELECT process_id, harness, system, source, session_id
        FROM insight.vitals_sessions WHERE system = ${name} AND t = ${t}
        UNION
        SELECT process_id, harness, system, source, session_id
        FROM insight.vitals_requests
        WHERE system = ${name} AND t = ${t} AND process_id IS NOT NULL
      ) x
      JOIN insight.sessions s
        ON (s.harness, s.system, s.source, s.session_id)
         = (x.harness, x.system, x.source, x.session_id)
      ORDER BY x.process_id, s.started_at, x.session_id
    `,
    sql`
      SELECT st.harness, st.source, st.session_id, st.link, st.candidates::int AS candidates,
             s.first_cwd, s.last_cwd, s.first_git_branch, s.last_git_branch
      FROM insight.session_stretches st
      JOIN insight.sessions s
        ON (s.harness, s.system, s.source, s.session_id)
         = (st.harness, st.system, st.source, st.session_id)
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
    memoryTotalBytes: sample.memory_total_bytes,
    memoryUsedBytes: sample.memory_used_bytes,
    processes: processes.map((row): SampleProcess => ({
      cores: row.cores ?? undefined,
      harness: row.harness,
      pid: row.pid,
      processId: row.process_id,
      project: projectOf(row.cwd),
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

type RecordRow = { kind: string; name: string; record: Record<string, unknown> };

type ChecksRow = {
  file_records: { digest: string; record: string }[] | null;
  files: { path: string; record: string; since: number; state: string }[] | null;
  services: (ServiceCheck & { service: string })[] | null;
};

type RunRow = {
  job: string;
  latest_run: { exitStatus: number; finished: string; started: string };
};

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const NUMBER_FIELDS = ['day', 'hour', 'minute', 'month', 'weekday'] as const;

// A job record's schedule: its calendar entries, each with the numeric fields
// it names.
const scheduleOf = (schedule: unknown): ScheduleEntry[] =>
  Array.isArray(schedule)
    ? schedule.map((entry: unknown) => {
        const found: ScheduleEntry = {};
        for (const key of NUMBER_FIELDS) {
          const value = field(entry, key);
          if (typeof value === 'number') {
            found[key] = value;
          }
        }
        return found;
      })
    : [];

// A files record's files, each with its path and hash.
const filesOf = (files: unknown): { path: string; sha256: string }[] =>
  Array.isArray(files)
    ? files.flatMap((entry: unknown) => {
        const path = field(entry, 'path');
        const sha256 = field(entry, 'sha256');
        return typeof path === 'string' && typeof sha256 === 'string' ? [{ path, sha256 }] : [];
      })
    : [];

const toRun = (run: RunRow['latest_run']): JobRun => ({
  exitStatus: run.exitStatus,
  finished: Date.parse(run.finished),
  started: Date.parse(run.started),
});

// The checks of a Service: its supervisor's first, then the others by name.
const byCheck = (a: ServiceCheck, b: ServiceCheck) =>
  Number(b.check === 'supervisor') - Number(a.check === 'supervisor') ||
  a.check.localeCompare(b.check);

const isJobCondition = (kind: string): kind is RecordedJob['open'][number] =>
  kind === 'job_failing' || kind === 'job_overdue';

// What System `name`'s provisioner recorded, with the latest checks and runs,
// and its Timeline: every Condition of the last 7 days before `now` and every
// one still open, newest received first. Read-only.
export const readSystemRecords = async (
  sql: SQL,
  { name, now }: { name: string; now: number },
): Promise<SystemRecords> => {
  const [records, checks, runs, conditions]: [RecordRow[], ChecksRow[], RunRow[], ConditionRow[]] =
    await Promise.all([
      sql`SELECT kind, name, record FROM mirrored_records WHERE system = ${name} ORDER BY kind, name`,
      sql`SELECT services, files, file_records FROM check_sets WHERE system = ${name}`,
      sql`SELECT job, latest_run FROM mirrored_runs WHERE system = ${name}`,
      sql`
      SELECT system, kind, subject, raised_at, cleared_at, latest_reason
      FROM conditions
      WHERE system = ${name}
        AND (cleared_at IS NULL OR cleared_at >= ${new Date(now - TIMELINE_MS)})
      -- Newest received first (ADR-0005), so a step back in the Hub's clock
      -- cannot reorder the Timeline.
      ORDER BY id DESC
    `,
    ]);
  const of = (kind: string) => records.filter((row) => row.kind === kind);
  const serviceChecks = checks[0]?.services ?? [];
  const fileChecks = checks[0]?.files ?? [];
  // As in the Hub's Drift rule: the checks speak for a files record only when
  // their files part names it with the digest of the record the Hub mirrors.
  const judged = new Map((checks[0]?.file_records ?? []).map((row) => [row.record, row.digest]));
  const files = await Promise.all(
    of('files').map(async ({ name: record, record: body }): Promise<RecordedFiles> => {
      const listed = filesOf(body.files);
      const checked =
        checks[0]?.files != null &&
        judged.get(record) === (await filesRecordDigest({ files: listed }));
      return {
        checked,
        count: listed.length,
        issues: checked
          ? fileChecks
              .filter((check) => check.record === record)
              .map(({ path, since, state }): FileIssue => ({ path, since, state }))
          : [],
        name: record,
      };
    }),
  );
  const runOf = new Map(runs.map((row) => [row.job, toRun(row.latest_run)]));
  const openJobConditions = conditions.filter(
    (row) => row.cleared_at === null && isJobCondition(row.kind),
  );
  const timeline = conditions.map((row): TimelineEntry => ({
    clearedAt: row.cleared_at?.getTime(),
    kind: conditionKind(row.kind),
    raisedAt: row.raised_at.getTime(),
    reason: row.latest_reason,
    subject: row.subject,
  }));
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
      jobs: of('job').map(({ name: job, record }): RecordedJob => ({
        latestRun: runOf.get(job),
        name: job,
        open: openJobConditions
          .filter((row) => row.subject === job)
          .map((row) => row.kind)
          .filter(isJobCondition),
        schedule: scheduleOf(record.schedule),
      })),
      services: of('service').map(({ name: service, record }): RecordedService => ({
        checks: serviceChecks
          .filter((check) => check.service === service)
          .map(({ check, detail, since, state }) => ({ check, detail, since, state }))
          .toSorted(byCheck),
        name: service,
        supervisor: text(record.supervisor) ?? 'none',
      })),
    },
    timeline,
  };
};
