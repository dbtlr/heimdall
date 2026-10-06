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
        -- Seconds and milliseconds apart: interval arithmetic runs in double
        -- precision, which would round a large millisecond count.
        timestamptz 'epoch'
          + ((s->>'t')::bigint / 1000) * interval '1 second'
          + ((s->>'t')::bigint % 1000) * interval '1 millisecond',
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
    return { skipped: report.samples.length - stored.length, stored: stored.length };
  });

// One System as the page shows it: when the Hub last heard from it, which
// Collector build reported, and its newest Vitals sample.
export type SystemSummary = {
  collector: Report['collector'];
  lastSeenAt: number;
  latest: VitalsSample;
  name: string;
};

type SummaryRow = {
  collector_arch: string;
  collector_cpu_percent: number;
  collector_platform: Report['collector']['platform'];
  collector_rss_bytes: string;
  collector_version: string;
  cpu_busy_percent: number;
  disks: VitalsSample['disks'];
  last_seen_at: Date;
  load_1: number;
  load_5: number;
  load_15: number;
  memory_total_bytes: string;
  memory_used_bytes: string;
  name: string;
  t: Date;
  uptime_seconds: number;
};

// Every System the Hub has heard from, by name, each with its newest sample.
export const listSystems = async (sql: SQL): Promise<SystemSummary[]> => {
  const rows: SummaryRow[] = await sql`
    SELECT s.name, s.last_seen_at, s.collector_version, s.collector_platform, s.collector_arch,
           v.t, v.cpu_busy_percent, v.memory_total_bytes, v.memory_used_bytes,
           v.load_1, v.load_5, v.load_15, v.uptime_seconds, v.disks,
           v.collector_cpu_percent, v.collector_rss_bytes
    FROM systems s
    JOIN LATERAL (
      SELECT * FROM vitals_samples WHERE system = s.name ORDER BY t DESC LIMIT 1
    ) v ON true
    ORDER BY s.name
  `;
  return rows.map((row) => ({
    collector: {
      arch: row.collector_arch,
      platform: row.collector_platform,
      version: row.collector_version,
    },
    lastSeenAt: row.last_seen_at.getTime(),
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
    name: row.name,
  }));
};
