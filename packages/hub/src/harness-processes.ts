import type { HarnessProcessesSection } from '@heimdall/schema';
import type { SQL } from 'bun';

import { storableJson } from './storable.ts';

// How far two start times may differ and still be one process. The Collector
// reads a start to the second, from clocks that can differ by a second between
// reads and across a Collector restart; a pid reused by a new process starts
// much later.
const SAME_PROCESS_SECONDS = 10;

// Applies a Report's harnessProcesses section to the System's processes:
// each process in it is updated in place or added, and every process the Hub
// held as running that the section no longer lists ended while the Collector was
// not looking, so it is closed at the last time the Collector saw it and marked
// `end_missed`. A section never changes what an earlier-sent Report left: a row
// moves only for a section sent at or after the one that last touched it, unless
// the row claims a time after `receivedAt`, which comes from a bad clock. The
// System's row is locked by the Report's own insert, so concurrent Reports apply
// in order.
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
  const incoming = storableJson(section.processes);
  // The rows the section lists, in place. Peak memory only grows, a known
  // working directory is not forgotten, and a process listed without an end is
  // running.
  await sql`
    WITH incoming AS (
      SELECT p->>'harness' AS harness, (p->>'pid')::integer AS pid,
             to_timestamp((p->>'startedAt')::bigint / 1000.0) AS started_at,
             to_timestamp((p->>'endedAt')::bigint / 1000.0) AS ended_at,
             p->>'cwd' AS cwd, (p->>'cpuMicros')::bigint AS cpu_micros,
             (p->>'rssBytes')::bigint AS rss_bytes, (p->>'peakRssBytes')::bigint AS peak_rss_bytes,
             to_timestamp((p->>'lastSeenAt')::bigint / 1000.0) AS last_seen_at
      FROM jsonb_array_elements(${incoming}::text::jsonb) AS p
    )
    UPDATE harness_processes h SET
      ended_at = i.ended_at,
      end_missed = false,
      cwd = COALESCE(i.cwd, h.cwd),
      cpu_micros = i.cpu_micros,
      rss_bytes = i.rss_bytes,
      peak_rss_bytes = GREATEST(h.peak_rss_bytes, i.peak_rss_bytes),
      last_seen_at = i.last_seen_at,
      sent_at = ${sent}
    FROM incoming i
    WHERE h.system = ${system} AND h.harness = i.harness AND h.pid = i.pid
      AND abs(extract(epoch FROM h.started_at - i.started_at)) <= ${SAME_PROCESS_SECONDS}
      AND (h.sent_at <= ${sent} OR h.sent_at > ${receivedAt})
  `;
  await sql`
    WITH incoming AS (
      SELECT p->>'harness' AS harness, (p->>'pid')::integer AS pid,
             to_timestamp((p->>'startedAt')::bigint / 1000.0) AS started_at,
             to_timestamp((p->>'endedAt')::bigint / 1000.0) AS ended_at,
             p->>'cwd' AS cwd, (p->>'cpuMicros')::bigint AS cpu_micros,
             (p->>'rssBytes')::bigint AS rss_bytes, (p->>'peakRssBytes')::bigint AS peak_rss_bytes,
             to_timestamp((p->>'lastSeenAt')::bigint / 1000.0) AS last_seen_at
      FROM jsonb_array_elements(${incoming}::text::jsonb) AS p
    )
    INSERT INTO harness_processes (
      system, harness, pid, started_at, ended_at, cwd, cpu_micros, rss_bytes,
      peak_rss_bytes, last_seen_at, sent_at
    )
    SELECT ${system}, i.harness, i.pid, i.started_at, i.ended_at, i.cwd, i.cpu_micros,
           i.rss_bytes, i.peak_rss_bytes, i.last_seen_at, ${sent}
    FROM incoming i
    WHERE NOT EXISTS (
      SELECT 1 FROM harness_processes h
      WHERE h.system = ${system} AND h.harness = i.harness AND h.pid = i.pid
        AND abs(extract(epoch FROM h.started_at - i.started_at)) <= ${SAME_PROCESS_SECONDS}
    )
  `;
  // Running rows this section did not touch ended unseen.
  await sql`
    UPDATE harness_processes SET ended_at = last_seen_at, end_missed = true
    WHERE system = ${system} AND ended_at IS NULL AND sent_at < ${sent}
  `;
};

// One process as the Hub holds it, for the join to Sessions by Harness, System,
// working directory, and overlapping time.
export type StoredHarnessProcess = {
  cpuMicros: number;
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
  rssBytes: number;
  startedAt: number;
};

type Row = {
  cpu_micros: string;
  cwd: string | null;
  end_missed: boolean;
  ended_at: Date | null;
  harness: string;
  last_seen_at: Date;
  peak_rss_bytes: string;
  pid: number;
  rss_bytes: string;
  started_at: Date;
};

// A System's Harness processes, oldest start first.
export const listHarnessProcesses = async (
  sql: SQL,
  system: string,
): Promise<StoredHarnessProcess[]> => {
  const rows: Row[] = await sql`
    SELECT harness, pid, started_at, ended_at, end_missed, cwd, cpu_micros, rss_bytes,
           peak_rss_bytes, last_seen_at
    FROM harness_processes WHERE system = ${system}
    ORDER BY started_at, harness, pid
  `;
  return rows.map((row) => ({
    cpuMicros: Number(row.cpu_micros),
    cwd: row.cwd,
    endMissed: row.end_missed,
    endedAt: row.ended_at?.getTime(),
    harness: row.harness,
    lastSeenAt: row.last_seen_at.getTime(),
    peakRssBytes: Number(row.peak_rss_bytes),
    pid: row.pid,
    rssBytes: Number(row.rss_bytes),
    startedAt: row.started_at.getTime(),
  }));
};
