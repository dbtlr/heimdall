import type { SQL } from 'bun';

// One schema change. Versions strictly increase, and an applied migration is
// never edited: a later change is a new migration. `serve` runs migrations
// under a 30-second statement timeout; a longer one raises it with SET LOCAL.
export type Migration = { sql: string; version: number };

export const MIGRATIONS: readonly Migration[] = [
  {
    // Each System the Hub has heard from, and the time it last did (glossary: Last seen).
    // Samples keep their Vitals in columns and their disks as JSON, keyed by
    // System and time so a resent sample is skipped (ADR-0004).
    sql: `
      CREATE TABLE systems (
        name text PRIMARY KEY,
        last_seen_at timestamptz NOT NULL,
        collector_version text NOT NULL,
        collector_platform text NOT NULL,
        collector_arch text NOT NULL
      );

      CREATE TABLE vitals_samples (
        system text NOT NULL REFERENCES systems (name),
        t timestamptz NOT NULL,
        cpu_busy_percent double precision NOT NULL,
        memory_total_bytes bigint NOT NULL,
        memory_used_bytes bigint NOT NULL,
        load_1 double precision NOT NULL,
        load_5 double precision NOT NULL,
        load_15 double precision NOT NULL,
        uptime_seconds double precision NOT NULL,
        disks jsonb NOT NULL,
        collector_cpu_percent double precision NOT NULL,
        collector_rss_bytes bigint NOT NULL,
        PRIMARY KEY (system, t)
      );
    `,
    version: 1,
  },
  {
    // A System may be seen before any Report from it is stored, through a
    // rejected one, so its Collector build can be unknown (ADR-0005). Each
    // Condition is raised once and cleared once. A System holds at most one open
    // Condition of each kind and subject, so M3 can hold one per Service or
    // Backup Job; a Condition about the System itself has an empty subject.
    // The Timeline is read from these rows.
    sql: `
      ALTER TABLE systems
        ALTER COLUMN collector_version DROP NOT NULL,
        ALTER COLUMN collector_platform DROP NOT NULL,
        ALTER COLUMN collector_arch DROP NOT NULL;

      CREATE TABLE conditions (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        system text NOT NULL REFERENCES systems (name),
        kind text NOT NULL,
        subject text NOT NULL DEFAULT '',
        raised_at timestamptz NOT NULL,
        raised_reason text NOT NULL,
        latest_at timestamptz NOT NULL,
        latest_reason text NOT NULL,
        cleared_at timestamptz
      );

      CREATE UNIQUE INDEX conditions_open ON conditions (system, kind, subject) WHERE cleared_at IS NULL;
      CREATE INDEX conditions_by_system ON conditions (system, raised_at DESC);
    `,
    version: 2,
  },
  {
    // Vitals roll up into 5-minute buckets, aligned to UTC, as samples arrive,
    // so raw samples can be pruned (ADR-0008). A bucket keeps the count, min,
    // sum, and max of each rolled-up Vital; average is sum over count. Byte
    // sums are numeric: a bucket may hold a sample per millisecond, which
    // could overflow bigint. The smallest uptime marks a reboot in the bucket.
    // Disks roll up per mount. The rollups are backfilled from the samples
    // already stored, which can outlast the usual statement timeout.
    sql: `
      SET LOCAL statement_timeout = '10min';

      CREATE TABLE vitals_rollups (
        system text NOT NULL REFERENCES systems (name),
        bucket timestamptz NOT NULL,
        samples integer NOT NULL,
        cpu_busy_min double precision NOT NULL,
        cpu_busy_sum double precision NOT NULL,
        cpu_busy_max double precision NOT NULL,
        memory_used_min bigint NOT NULL,
        memory_used_sum numeric NOT NULL,
        memory_used_max bigint NOT NULL,
        memory_total_max bigint NOT NULL,
        load_1_min double precision NOT NULL,
        load_1_sum double precision NOT NULL,
        load_1_max double precision NOT NULL,
        uptime_min double precision NOT NULL,
        collector_cpu_sum double precision NOT NULL,
        collector_cpu_max double precision NOT NULL,
        collector_rss_sum numeric NOT NULL,
        collector_rss_max bigint NOT NULL,
        PRIMARY KEY (system, bucket)
      );

      CREATE TABLE disk_rollups (
        system text NOT NULL REFERENCES systems (name),
        bucket timestamptz NOT NULL,
        mount text NOT NULL,
        used_max bigint NOT NULL,
        total_max bigint NOT NULL,
        PRIMARY KEY (system, bucket, mount)
      );

      INSERT INTO vitals_rollups
      SELECT
        system,
        date_bin('5 minutes', t, timestamptz '2000-01-01 00:00:00+00'),
        count(*),
        min(cpu_busy_percent), sum(cpu_busy_percent), max(cpu_busy_percent),
        min(memory_used_bytes), sum(memory_used_bytes), max(memory_used_bytes),
        max(memory_total_bytes),
        min(load_1), sum(load_1), max(load_1),
        min(uptime_seconds),
        sum(collector_cpu_percent), max(collector_cpu_percent),
        sum(collector_rss_bytes), max(collector_rss_bytes)
      FROM vitals_samples
      GROUP BY 1, 2;

      INSERT INTO disk_rollups
      SELECT
        system,
        date_bin('5 minutes', t, timestamptz '2000-01-01 00:00:00+00'),
        d->>'mount',
        max((d->>'usedBytes')::bigint),
        max((d->>'totalBytes')::bigint)
      FROM vitals_samples, jsonb_array_elements(disks) AS d
      GROUP BY 1, 2, 3;
    `,
    version: 3,
  },
];

// Serializes Hubs that start against the same database at once. The name is
// arbitrary; it only has to be the same for every Hub.
const MIGRATION_LOCK = 'heimdall-migrations';

// Brings the database to the latest version in one transaction and answers the
// versions it applied, oldest first. Tests pass `migrations` to stop at an
// earlier version.
export const migrate = (sql: SQL, migrations = MIGRATIONS): Promise<number[]> =>
  sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const rows: { version: number }[] = await tx`SELECT version FROM schema_migrations`;
    const done = new Set(rows.map((row) => row.version));
    const applied: number[] = [];
    for (const migration of migrations) {
      if (done.has(migration.version)) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- migrations apply in order.
      await tx.unsafe(migration.sql);
      // oxlint-disable-next-line no-await-in-loop -- recorded with the migration it follows.
      await tx`INSERT INTO schema_migrations (version) VALUES (${migration.version})`;
      applied.push(migration.version);
    }
    return applied;
  });
