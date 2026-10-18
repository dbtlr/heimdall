import { SAME_HARNESS_PROCESS_MS } from '@heimdall/schema';
import type { HarnessProcessesSection } from '@heimdall/schema';
import type { SQL } from 'bun';

import { storableJson } from './storable.ts';

// Applies a Report's harnessProcesses section to the System's processes, in
// one statement:
//
// - Each process in the section is matched to the row it is: same Harness and
//   pid, and a start within SAME_HARNESS_PROCESS_MS. When a pid was reused
//   within the window, each process takes the row closest to its start and each
//   row is taken by one process, so an ended process and the one that reused
//   its pid never merge. A process with no row gets one.
// - A matched row is updated: peak memory only grows, a known working directory
//   is not forgotten, and a process listed without an end is running, with no
//   missed end. The repository goes with the working directory: a section that
//   reads the directory sets the repository it sends, null included, unless it
//   comes from a Collector too old to send one.
// - Each process's reading, CPU time and memory at `lastSeenAt`, is stored as a
//   sample and rolls up into its 5-minute bucket, once however often it is
//   resent (ADR-0008).
// - A row the Hub holds as running that the section does not list ended while
//   the Collector was not looking: it is closed at the last time the Collector
//   saw it and marked `end_missed`.
//
// A section never changes what a later-sent Report left: a row is updated or
// closed only by a section sent at or after the one that last touched it,
// unless the row claims a time after `receivedAt`, which comes from a bad
// clock. Samples are facts at their own time and are stored whenever sent.
//
// Concurrent Reports from one System apply one after the other: `storeReport`
// (store.ts) upserts the System's row first in the same transaction, which
// locks that row until the transaction ends, and this is the only writer of
// these tables. At READ COMMITTED this statement then sees every row an
// earlier Report committed, so it never adds a second row for one process.
// That is why the table has no unique constraint, which could not state the
// start window anyway.
export const storeHarnessProcesses = async (
  sql: SQL,
  {
    receivedAt,
    section,
    sentAt,
    system,
  }: { receivedAt: Date; section: HarnessProcessesSection; sentAt: number; system: string },
) => {
  const sent = new Date(sentAt);
  await sql`
    WITH incoming AS (
      SELECT e.idx, p->>'harness' AS harness, (p->>'pid')::integer AS pid,
             to_timestamp((p->>'startedAt')::bigint / 1000.0) AS started_at,
             to_timestamp((p->>'endedAt')::bigint / 1000.0) AS ended_at,
             p->>'cwd' AS cwd, p->>'repository' AS repository,
             p->'repository' IS NOT NULL AS sends_repository, (p->>'cpuMicros')::bigint AS cpu_micros,
             (p->>'rssBytes')::bigint AS rss_bytes, (p->>'peakRssBytes')::bigint AS peak_rss_bytes,
             to_timestamp((p->>'lastSeenAt')::bigint / 1000.0) AS last_seen_at
      FROM jsonb_array_elements(${storableJson(section.processes)}::text::jsonb)
        WITH ORDINALITY AS e (p, idx)
    ),
    candidates AS (
      SELECT i.idx, h.id, abs(extract(epoch FROM h.started_at - i.started_at)) AS apart
      FROM incoming i
      JOIN harness_processes h
        ON h.system = ${system} AND h.harness = i.harness AND h.pid = i.pid
       AND abs(extract(epoch FROM h.started_at - i.started_at)) * 1000 <= ${SAME_HARNESS_PROCESS_MS}
    ),
    -- Each process's closest row, then each row's closest process.
    closest AS (
      SELECT DISTINCT ON (idx) idx, id, apart FROM candidates ORDER BY idx, apart, id
    ),
    matched AS (
      SELECT DISTINCT ON (id) idx, id FROM closest ORDER BY id, apart, idx
    ),
    fresh AS (
      SELECT i.idx, nextval(pg_get_serial_sequence('harness_processes', 'id')) AS id
      FROM incoming i WHERE i.idx NOT IN (SELECT idx FROM matched)
    ),
    updated AS (
      UPDATE harness_processes h SET
        ended_at = i.ended_at,
        end_missed = false,
        cwd = COALESCE(i.cwd, h.cwd),
        repository = CASE WHEN i.cwd IS NOT NULL AND i.sends_repository
                          THEN i.repository ELSE h.repository END,
        peak_rss_bytes = GREATEST(h.peak_rss_bytes, i.peak_rss_bytes),
        last_seen_at = i.last_seen_at,
        sent_at = ${sent}
      FROM matched m JOIN incoming i USING (idx)
      WHERE h.id = m.id AND (h.sent_at <= ${sent} OR h.sent_at > ${receivedAt})
    ),
    added AS (
      INSERT INTO harness_processes (
        id, system, harness, pid, started_at, ended_at, cwd, repository, peak_rss_bytes,
        last_seen_at, sent_at
      )
      OVERRIDING SYSTEM VALUE
      SELECT f.id, ${system}, i.harness, i.pid, i.started_at, i.ended_at, i.cwd, i.repository,
             i.peak_rss_bytes, i.last_seen_at, ${sent}
      FROM fresh f JOIN incoming i USING (idx)
    ),
    stored AS (
      INSERT INTO harness_process_samples (process, t, cpu_micros, rss_bytes)
      SELECT o.id, i.last_seen_at, i.cpu_micros, i.rss_bytes
      FROM (SELECT idx, id FROM matched UNION ALL SELECT idx, id FROM fresh) AS o
      JOIN incoming i USING (idx)
      ON CONFLICT (process, t) DO NOTHING
      RETURNING *, date_bin('5 minutes', t, timestamptz '2000-01-01 00:00:00+00') AS bucket
    ),
    rolled AS (
      INSERT INTO harness_process_rollups AS r (
        process, bucket, samples, cpu_micros_min, cpu_micros_max, rss_min, rss_sum, rss_max
      )
      SELECT process, bucket, count(*), min(cpu_micros), max(cpu_micros),
             min(rss_bytes), sum(rss_bytes), max(rss_bytes)
      FROM stored
      GROUP BY process, bucket
      ON CONFLICT (process, bucket) DO UPDATE SET
        samples = r.samples + excluded.samples,
        cpu_micros_min = LEAST(r.cpu_micros_min, excluded.cpu_micros_min),
        cpu_micros_max = GREATEST(r.cpu_micros_max, excluded.cpu_micros_max),
        rss_min = LEAST(r.rss_min, excluded.rss_min),
        rss_sum = r.rss_sum + excluded.rss_sum,
        rss_max = GREATEST(r.rss_max, excluded.rss_max)
    )
    -- Running rows this section does not list ended unseen.
    UPDATE harness_processes SET ended_at = last_seen_at, end_missed = true
    WHERE system = ${system} AND ended_at IS NULL
      AND id NOT IN (SELECT id FROM matched)
      AND (sent_at < ${sent} OR sent_at > ${receivedAt})
  `;
};

// One process as the Hub holds it, for the join to Sessions by Harness, System,
// working directory, and overlapping time. Its CPU time and memory over time
// are its samples (`listHarnessProcessSamples`).
export type StoredHarnessProcess = {
  cwd: string | null;
  // True when the Collector did not see the process end: `endedAt` is then the
  // last time it saw it running, not the end.
  endMissed: boolean;
  // Undefined while the process is running.
  endedAt: number | undefined;
  harness: string;
  lastSeenAt: number;
  peakRssBytes: number;
  pid: number;
  // The repository the working directory belongs to, when the Collector
  // resolved one (ADR-0019).
  repository: string | null;
  startedAt: number;
};

type Row = {
  cwd: string | null;
  end_missed: boolean;
  ended_at: Date | null;
  harness: string;
  last_seen_at: Date;
  peak_rss_bytes: string;
  pid: number;
  repository: string | null;
  started_at: Date;
};

// A System's Harness processes, oldest start first.
export const listHarnessProcesses = async (
  sql: SQL,
  system: string,
): Promise<StoredHarnessProcess[]> => {
  const rows: Row[] = await sql`
    SELECT harness, pid, started_at, ended_at, end_missed, cwd, repository, peak_rss_bytes,
           last_seen_at
    FROM harness_processes WHERE system = ${system}
    ORDER BY started_at, harness, pid
  `;
  return rows.map((row) => ({
    cwd: row.cwd,
    endMissed: row.end_missed,
    endedAt: row.ended_at?.getTime(),
    harness: row.harness,
    lastSeenAt: row.last_seen_at.getTime(),
    peakRssBytes: Number(row.peak_rss_bytes),
    pid: row.pid,
    repository: row.repository,
    startedAt: row.started_at.getTime(),
  }));
};

// One reading of a process's tree: its cumulative CPU time and resident memory
// at `t`, with the process it belongs to.
export type StoredHarnessProcessSample = {
  cpuMicros: number;
  harness: string;
  pid: number;
  rssBytes: number;
  startedAt: number;
  t: number;
};

type SampleRow = {
  cpu_micros: string;
  harness: string;
  pid: number;
  rss_bytes: string;
  started_at: Date;
  t: Date;
};

// A System's Harness process samples, by process start, then time.
export const listHarnessProcessSamples = async (
  sql: SQL,
  system: string,
): Promise<StoredHarnessProcessSample[]> => {
  const rows: SampleRow[] = await sql`
    SELECT h.harness, h.pid, h.started_at, s.t, s.cpu_micros, s.rss_bytes
    FROM harness_process_samples s JOIN harness_processes h ON h.id = s.process
    WHERE h.system = ${system}
    ORDER BY h.started_at, h.harness, h.pid, s.t
  `;
  return rows.map((row) => ({
    cpuMicros: Number(row.cpu_micros),
    harness: row.harness,
    pid: row.pid,
    rssBytes: Number(row.rss_bytes),
    startedAt: row.started_at.getTime(),
    t: row.t.getTime(),
  }));
};
