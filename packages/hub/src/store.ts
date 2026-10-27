import { mirrorChecks, mirrorRecords, mirrorRuns } from '@heimdall/schema';
import type {
  ChecksSection,
  ConditionKind,
  HarnessesSection,
  RecordRef,
  RecordsSection,
  Report,
  RunsSection,
  ServiceStopsSection,
  TranscriptsSection,
} from '@heimdall/schema';
import type { SQL } from 'bun';

import { clear, raise } from './conditions.ts';
import { storeHarnessProcesses } from './harness-processes.ts';
import { storeServiceVersions } from './service-versions.ts';
import { storable, storableJson } from './storable.ts';
import { storeUpdates } from './update-observations.ts';

export type StoreResult = { skipped: number; stored: number };

// Records that the Hub heard from `system` at `at` (epoch milliseconds), on
// its own row lock (glossary: Last seen).
export const seeSystem = async (sql: SQL, { at, system }: { at: number; system: string }) => {
  await sql`
    INSERT INTO systems (name, last_seen_at) VALUES (${system}, ${new Date(at)})
    ON CONFLICT (name) DO UPDATE SET
      last_seen_at = GREATEST(systems.last_seen_at, excluded.last_seen_at)
  `;
};

// Records a Report received at `receivedAt` (epoch milliseconds), the Hub's
// clock when the request arrived: the System is seen at that time, its clock
// offset is the Report's sent time less that time, and each sample is stored
// unless the Hub already holds one for the same System and time (ADR-0004).
export const storeReport = (
  sql: SQL,
  { receivedAt, report }: { receivedAt: number; report: Report },
): Promise<StoreResult> =>
  sql.begin(async (tx) => {
    const seenAt = new Date(receivedAt);
    await tx`
      INSERT INTO systems (
        name, last_seen_at, collector_version, collector_platform, collector_arch, time_zone, sleeps,
        clock_offset_ms, clock_offset_at
      )
      VALUES (${report.system}, ${seenAt}, ${storable(report.collector.version)},
              ${report.collector.platform}, ${storable(report.collector.arch)},
              ${report.timeZone ?? null}, ${report.sleeps ?? null},
              ${report.sentAt - receivedAt}, ${seenAt})
      ON CONFLICT (name) DO UPDATE SET
        last_seen_at = GREATEST(systems.last_seen_at, excluded.last_seen_at),
        collector_version = excluded.collector_version,
        collector_platform = excluded.collector_platform,
        collector_arch = excluded.collector_arch,
        -- A Report without a zone leaves the one the System has. The last Report to
        -- arrive wins, which is fine with one Collector per System.
        time_zone = COALESCE(excluded.time_zone, systems.time_zone),
        -- Likewise a Report without sleeps, from a Collector that predates it.
        sleeps = COALESCE(excluded.sleeps, systems.sleeps),
        -- Only the latest offset is kept, whichever way the Hub's clock moved.
        clock_offset_ms = excluded.clock_offset_ms,
        clock_offset_at = excluded.clock_offset_at
    `;
    // The samples travel as one JSON parameter, so a Report of any size is one
    // statement. The samples the insert stored, and only those, roll up into
    // their 5-minute buckets, so a resent sample never counts twice (ADR-0008).
    const stored: { t: Date }[] = await tx`
      WITH stored AS (
        INSERT INTO vitals_samples (
          system, t, cpu_busy_percent, memory_total_bytes, memory_used_bytes,
          load_1, load_5, load_15, uptime_seconds, disks,
          collector_cpu_percent, collector_rss_bytes, memory_pressure, collector_platform, processes
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
          (s->'collector'->>'rssBytes')::bigint,
          s->'memory'->>'pressure', ${report.collector.platform}, s->'processes'
        FROM jsonb_array_elements(${storableJson(report.samples)}::text::jsonb) AS s
        ON CONFLICT (system, t) DO NOTHING
        RETURNING *, date_bin('5 minutes', t, timestamptz '2000-01-01 00:00:00+00') AS bucket
      ),
      vitals AS (
        INSERT INTO vitals_rollups AS r (
          system, bucket, samples,
          cpu_busy_min, cpu_busy_sum, cpu_busy_max,
          memory_used_min, memory_used_sum, memory_used_max,
          memory_total_max,
          load_1_min, load_1_sum, load_1_max,
          uptime_min,
          collector_cpu_sum, collector_cpu_max,
          collector_rss_sum, collector_rss_max
        )
        SELECT
          system, bucket, count(*),
          min(cpu_busy_percent), sum(cpu_busy_percent), max(cpu_busy_percent),
          min(memory_used_bytes), sum(memory_used_bytes), max(memory_used_bytes),
          max(memory_total_bytes),
          min(load_1), sum(load_1), max(load_1),
          min(uptime_seconds),
          sum(collector_cpu_percent), max(collector_cpu_percent),
          sum(collector_rss_bytes), max(collector_rss_bytes)
        FROM stored
        GROUP BY system, bucket
        ON CONFLICT (system, bucket) DO UPDATE SET
          samples = r.samples + excluded.samples,
          cpu_busy_min = LEAST(r.cpu_busy_min, excluded.cpu_busy_min),
          cpu_busy_sum = r.cpu_busy_sum + excluded.cpu_busy_sum,
          cpu_busy_max = GREATEST(r.cpu_busy_max, excluded.cpu_busy_max),
          memory_used_min = LEAST(r.memory_used_min, excluded.memory_used_min),
          memory_used_sum = r.memory_used_sum + excluded.memory_used_sum,
          memory_used_max = GREATEST(r.memory_used_max, excluded.memory_used_max),
          memory_total_max = GREATEST(r.memory_total_max, excluded.memory_total_max),
          load_1_min = LEAST(r.load_1_min, excluded.load_1_min),
          load_1_sum = r.load_1_sum + excluded.load_1_sum,
          load_1_max = GREATEST(r.load_1_max, excluded.load_1_max),
          uptime_min = LEAST(r.uptime_min, excluded.uptime_min),
          collector_cpu_sum = r.collector_cpu_sum + excluded.collector_cpu_sum,
          collector_cpu_max = GREATEST(r.collector_cpu_max, excluded.collector_cpu_max),
          collector_rss_sum = r.collector_rss_sum + excluded.collector_rss_sum,
          collector_rss_max = GREATEST(r.collector_rss_max, excluded.collector_rss_max)
      ),
      disks AS (
        INSERT INTO disk_rollups AS r (system, bucket, mount, used_max, total_max)
        SELECT
          system, bucket, d->>'mount',
          max((d->>'usedBytes')::bigint), max((d->>'totalBytes')::bigint)
        FROM stored, jsonb_array_elements(stored.disks) AS d
        GROUP BY system, bucket, d->>'mount'
        ON CONFLICT (system, bucket, mount) DO UPDATE SET
          used_max = GREATEST(r.used_max, excluded.used_max),
          total_max = GREATEST(r.total_max, excluded.total_max)
      )
      SELECT t FROM stored
    `;
    if (stored.length > 0) {
      const first = new Date(Math.min(...stored.map((row) => row.t.getTime())));
      await tx`
        UPDATE load_evaluations SET dirty_from = LEAST(COALESCE(dirty_from, ${first}), ${first})
        WHERE system = ${report.system} AND through >= ${first}
      `;
      await tx`
        UPDATE hot_process_evaluations SET dirty_from = LEAST(COALESCE(dirty_from, ${first}), ${first})
        WHERE system = ${report.system} AND through >= ${first}
      `;
    }
    if (report.transcripts !== undefined) {
      await storeTranscriptSources(tx, {
        receivedAt: seenAt,
        report,
        transcripts: report.transcripts,
      });
    }
    if (report.harnesses !== undefined) {
      await storeHarnessInstalls(tx, {
        harnesses: report.harnesses,
        receivedAt: seenAt,
        report,
      });
    }
    if (report.harnessProcesses !== undefined) {
      await storeHarnessProcesses(tx, {
        receivedAt: seenAt,
        section: report.harnessProcesses,
        sentAt: report.sentAt,
        system: report.system,
      });
    }
    if (report.records !== undefined) {
      await storeRecords(tx, { receivedAt: seenAt, report, section: report.records });
    }
    if (report.runs !== undefined) {
      await storeRuns(tx, { receivedAt: seenAt, report, section: report.runs });
    }
    if (report.checks !== undefined) {
      await storeChecks(tx, { receivedAt: seenAt, report, section: report.checks });
    }
    if (report.serviceStops !== undefined) {
      await storeServiceStops(tx, { receivedAt: seenAt, report, section: report.serviceStops });
    }
    if (report.updates !== undefined) {
      await storeUpdates(tx, { receivedAt, section: report.updates, system: report.system });
    }
    if (
      report.records !== undefined ||
      report.checks !== undefined ||
      report.updates !== undefined
    ) {
      await storeServiceVersions(tx, { receivedAt, system: report.system });
    }
    // A stored Report ends a run of rejections (ADR-0005).
    await clear(tx, { kind: REPORTS_REJECTED, now: seenAt, subject: '', system: report.system });
    return { skipped: report.samples.length - stored.length, stored: stored.length };
  });

// Replaces the System's set of transcript sources and its spool with a
// Report's, unless the Hub holds a set from a Report sent later (ADR-0013). A
// held set that claims a time after `receivedAt` comes from a bad clock, and
// gives way, so it cannot outlast every correct set.
const storeTranscriptSources = async (
  sql: SQL,
  {
    receivedAt,
    report: { sentAt, system },
    transcripts,
  }: { receivedAt: Date; report: Report; transcripts: TranscriptsSection },
) => {
  const { sources, spool } = transcripts;
  await sql`
    INSERT INTO transcript_sources (system, sources, spool_bytes, spool_oldest_at, sent_at)
    VALUES (${system}, ${storableJson(sources)}::text::jsonb, ${spool.bytes},
            ${spool.oldestAt === null ? null : new Date(spool.oldestAt)}, ${new Date(sentAt)})
    ON CONFLICT (system) DO UPDATE SET
      sources = excluded.sources,
      spool_bytes = excluded.spool_bytes,
      spool_oldest_at = excluded.spool_oldest_at,
      sent_at = excluded.sent_at
    WHERE transcript_sources.sent_at <= excluded.sent_at
       OR transcript_sources.sent_at > ${receivedAt}
  `;
  // Which Harness each source runs outlasts the set, so the projection can
  // parse a removed source's transcripts (ADR-0014). The latest Report sent
  // names it, under the same rule as the set.
  await sql`
    INSERT INTO transcript_source_harnesses (system, source, harness, sent_at)
    SELECT ${system}, s->>'name', s->>'harness', ${new Date(sentAt)}
    FROM jsonb_array_elements(${storableJson(sources)}::text::jsonb) AS s
    ON CONFLICT (system, source) DO UPDATE SET
      harness = excluded.harness,
      sent_at = excluded.sent_at
    WHERE transcript_source_harnesses.sent_at <= excluded.sent_at
       OR transcript_source_harnesses.sent_at > ${receivedAt}
  `;
};

// Replaces the System's Harness installs with a Report's, unless the Hub holds
// a list from a Report sent later. A held list that claims a time after
// `receivedAt` comes from a bad clock, and gives way.
const storeHarnessInstalls = async (
  sql: SQL,
  {
    harnesses,
    receivedAt,
    report: { sentAt, system },
  }: { harnesses: HarnessesSection; receivedAt: Date; report: Report },
) => {
  await sql`
    INSERT INTO harness_installs (system, installs, sent_at)
    VALUES (${system}, ${storableJson(harnesses.installs)}::text::jsonb, ${new Date(sentAt)})
    ON CONFLICT (system) DO UPDATE SET
      installs = excluded.installs,
      sent_at = excluded.sent_at
    WHERE harness_installs.sent_at <= excluded.sent_at
       OR harness_installs.sent_at > ${receivedAt}
  `;
};

// Replaces the System's mirror of its records with a Report's set, unless the
// Hub holds a set from a Report sent later (ADR-0011). A held set that claims
// a time after `receivedAt` comes from a bad clock, and gives way. A set over
// budget leaves no records, so none that may have changed is served. The set's
// row is locked until the transaction ends, so concurrent Reports apply in order.
const storeRecords = async (
  sql: SQL,
  { receivedAt, report, section }: { receivedAt: Date; report: Report; section: RecordsSection },
) => {
  const mirrored = mirrorRecords(section);
  const overBudget = 'overBudget' in mirrored ? mirrored.overBudget.bytes : null;
  const unreadable = 'unreadable' in mirrored ? mirrored.unreadable : [];
  const records = 'records' in mirrored ? mirrored.records : [];
  const replaced: unknown[] = await sql`
    INSERT INTO record_sets (system, sent_at, received_at, unreadable, over_budget_bytes)
    VALUES (${report.system}, ${new Date(report.sentAt)}, ${receivedAt},
            ${storableJson(unreadable)}::text::jsonb, ${overBudget})
    ON CONFLICT (system) DO UPDATE SET
      sent_at = excluded.sent_at,
      received_at = excluded.received_at,
      unreadable = excluded.unreadable,
      over_budget_bytes = excluded.over_budget_bytes
    WHERE record_sets.sent_at <= excluded.sent_at
       OR record_sets.sent_at > ${receivedAt}
    RETURNING system
  `;
  if (replaced.length === 0) {
    return;
  }
  await sql`DELETE FROM mirrored_records WHERE system = ${report.system}`;
  await sql`
    INSERT INTO mirrored_records (system, kind, name, record)
    SELECT ${report.system}, r->>'kind', r->>'name', r->'record'
    FROM jsonb_array_elements(${storableJson(records)}::text::jsonb) AS r
  `;
  if (overBudget === null) {
    await trackFirstMirrored(sql, { receivedAt, records, system: report.system, unreadable });
  }
};

// Keeps when the Hub first mirrored each record of a set that fit: a record
// the set leaves out is forgotten, one it lists as unreadable is still on the
// System and keeps its time, and one mirrored for the first time starts now.
const trackFirstMirrored = async (
  sql: SQL,
  {
    receivedAt,
    records,
    system,
    unreadable,
  }: { receivedAt: Date; records: RecordRef[]; system: string; unreadable: RecordRef[] },
) => {
  const held = storableJson([...records, ...unreadable].map(({ kind, name }) => ({ kind, name })));
  await sql`
    DELETE FROM records_first_mirrored f
    WHERE f.system = ${system}
      AND NOT EXISTS (
        SELECT FROM jsonb_array_elements(${held}::text::jsonb) AS r
        WHERE r->>'kind' = f.kind AND r->>'name' = f.name
      )
  `;
  await sql`
    INSERT INTO records_first_mirrored (system, kind, name, first_mirrored_at)
    SELECT ${system}, r->>'kind', r->>'name', ${receivedAt}
    FROM jsonb_array_elements(${storableJson(records.map(({ kind, name }) => ({ kind, name })))}::text::jsonb) AS r
    ON CONFLICT (system, kind, name) DO NOTHING
  `;
};

// Replaces the System's latest runs with a Report's, unless the Hub holds runs
// from a Report sent later. Held runs that claim a time after `receivedAt` come
// from a bad clock, and give way. Runs over budget leave no jobs, so none that
// may have changed is served. The runs' row is locked until the transaction
// ends, so concurrent Reports apply in order.
const storeRuns = async (
  sql: SQL,
  { receivedAt, report, section }: { receivedAt: Date; report: Report; section: RunsSection },
) => {
  const mirrored = mirrorRuns(section);
  const overBudget = 'overBudget' in mirrored ? mirrored.overBudget.bytes : null;
  const unreadable = 'unreadable' in mirrored ? mirrored.unreadable : [];
  const jobs = 'jobs' in mirrored ? mirrored.jobs : [];
  const replaced: unknown[] = await sql`
    INSERT INTO run_sets (system, sent_at, received_at, unreadable, over_budget_bytes)
    VALUES (${report.system}, ${new Date(report.sentAt)}, ${receivedAt},
            ${storableJson(unreadable)}::text::jsonb, ${overBudget})
    ON CONFLICT (system) DO UPDATE SET
      sent_at = excluded.sent_at,
      received_at = excluded.received_at,
      unreadable = excluded.unreadable,
      over_budget_bytes = excluded.over_budget_bytes
    WHERE run_sets.sent_at <= excluded.sent_at
       OR run_sets.sent_at > ${receivedAt}
    RETURNING system
  `;
  if (replaced.length === 0) {
    return;
  }
  await sql`DELETE FROM mirrored_runs WHERE system = ${report.system}`;
  // A job with no success sends null, which `->` reads as a JSON null, not NULL.
  await sql`
    INSERT INTO mirrored_runs (system, job, latest_run, latest_success)
    SELECT ${report.system}, j->>'job', j->'latestRun', NULLIF(j->'latestSuccess', 'null'::jsonb)
    FROM jsonb_array_elements(${storableJson(jobs)}::text::jsonb) AS j
  `;
};

// Replaces the System's latest checks with a Report's, unless the Hub holds
// checks from a Report sent later. Held checks that claim a time after
// `receivedAt` come from a bad clock, and give way. A part over budget leaves
// none of its entries, so none that may have changed is served. The checks' row
// is locked until the transaction ends, so concurrent Reports apply in order.
const storeChecks = async (
  sql: SQL,
  { receivedAt, report, section }: { receivedAt: Date; report: Report; section: ChecksSection },
) => {
  const mirrored = mirrorChecks(section);
  const files = mirrored.files === null ? null : storableJson(mirrored.files);
  const fileRecords = mirrored.fileRecords === null ? null : storableJson(mirrored.fileRecords);
  const services = mirrored.services === null ? null : storableJson(mirrored.services);
  await sql`
    INSERT INTO check_sets (
      system, sent_at, received_at, files_over_budget_bytes, files, file_records,
      services_over_budget_bytes, services
    )
    VALUES (${report.system}, ${new Date(report.sentAt)}, ${receivedAt},
            ${mirrored.filesOverBudgetBytes},
            ${files}::text::jsonb,
            ${fileRecords}::text::jsonb,
            ${mirrored.servicesOverBudgetBytes}, ${services}::text::jsonb)
    ON CONFLICT (system) DO UPDATE SET
      sent_at = excluded.sent_at,
      received_at = excluded.received_at,
      files_over_budget_bytes = excluded.files_over_budget_bytes,
      files = excluded.files,
      file_records = excluded.file_records,
      services_over_budget_bytes = excluded.services_over_budget_bytes,
      services = excluded.services
    WHERE check_sets.sent_at <= excluded.sent_at
       OR check_sets.sent_at > ${receivedAt}
  `;
};

// Each stop is a whole view, including nulls. A corrected clock can replace
// a future-dated view under the same sent-time guard as the latest checks.
const storeServiceStops = async (
  sql: SQL,
  {
    receivedAt,
    report,
    section,
  }: { receivedAt: Date; report: Report; section: ServiceStopsSection },
) => {
  await sql`
    INSERT INTO service_stops (
      system, service, stopped_at, started_at, ongoing, restarts, result, exit_status, sent_at, received_at
    )
    SELECT ${report.system}, s->>'service',
           -- As with samples, whole days keep milliseconds exact across the
           -- wire's timestamp range, without parsing extended ISO years.
           (timestamp 'epoch'
             + ((s->>'stoppedAt')::bigint / 86400000) * interval '1 day'
             + ((s->>'stoppedAt')::bigint % 86400000) * interval '1 millisecond') AT TIME ZONE 'UTC',
           (timestamp 'epoch'
             + ((s->>'startedAt')::bigint / 86400000) * interval '1 day'
             + ((s->>'startedAt')::bigint % 86400000) * interval '1 millisecond') AT TIME ZONE 'UTC',
           (s->>'ongoing')::boolean, (s->>'restarts')::integer,
           s->>'result', (s->>'exitStatus')::integer, ${new Date(report.sentAt)}, ${receivedAt}
    FROM jsonb_array_elements(${storableJson(section.stops)}::text::jsonb) AS s
    ON CONFLICT (system, service, stopped_at) DO UPDATE SET
      started_at = excluded.started_at,
      ongoing = excluded.ongoing,
      restarts = excluded.restarts,
      result = excluded.result,
      exit_status = excluded.exit_status,
      sent_at = excluded.sent_at,
      received_at = excluded.received_at
    WHERE service_stops.sent_at <= excluded.sent_at
       OR service_stops.sent_at > ${receivedAt}
  `;
};

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
    await seeSystem(tx, { at: receivedAt, system });
    await raise(tx, { kind: REPORTS_REJECTED, now: at, reason: why, subject: '', system });
  });
