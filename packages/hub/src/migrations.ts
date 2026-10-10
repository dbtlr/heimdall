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
    // Condition of each kind and subject, so M4 can hold one per Service or
    // job; a Condition about the System itself has an empty subject.
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
  {
    // Each paired System's token, and the Pairing codes issued and not yet
    // redeemed, kept only as SHA-256 hashes (ADR-0009). A System may pair
    // before the Hub hears from it, so neither table refers to `systems`, and
    // unpairing leaves the System's history. A System has at most one token and
    // at most one pending code: issuing deletes its earlier code.
    sql: `
      CREATE TABLE paired_systems (
        system text PRIMARY KEY,
        token_hash bytea NOT NULL UNIQUE,
        paired_at timestamptz NOT NULL
      );

      CREATE TABLE pairing_codes (
        code_hash bytea PRIMARY KEY,
        system text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL
      );
    `,
    version: 4,
  },
  {
    // Transcripts as their Collectors uploaded them (ADR-0013). A generation
    // is one continuous run of a file's content; `held` counts the bytes of
    // the file it holds and `stored_bytes` the gzipped bytes of its chunks.
    // Each chunk is stored gzipped, as uploaded, at the file offset it starts
    // from; its content is a gzip stream, which may hold several members. A
    // path is indexed by its hash, since a long path outgrows an index entry.
    // A deleted generation keeps its row without its chunks, so the Hub
    // refuses its later chunks, and a path whose every generation is deleted
    // refuses new ones. Each System's latest set of sources and its spool
    // replace the earlier set; `sent_at` keeps an older Report from replacing
    // a newer one.
    sql: `
      CREATE TABLE transcript_generations (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        system text NOT NULL REFERENCES systems (name),
        source text NOT NULL,
        path text NOT NULL,
        held bigint NOT NULL DEFAULT 0,
        stored_bytes bigint NOT NULL DEFAULT 0,
        opened_at timestamptz NOT NULL,
        last_upload_at timestamptz NOT NULL,
        deleted_at timestamptz
      );

      CREATE INDEX transcript_generations_by_path
        ON transcript_generations (system, source, md5(path));
      CREATE INDEX transcript_generations_by_last_upload ON transcript_generations (last_upload_at);

      CREATE TABLE transcript_chunks (
        generation bigint NOT NULL REFERENCES transcript_generations (id),
        offset_bytes bigint NOT NULL,
        length bigint NOT NULL,
        content bytea NOT NULL,
        PRIMARY KEY (generation, offset_bytes)
      );

      CREATE TABLE transcript_sources (
        system text PRIMARY KEY REFERENCES systems (name),
        sources jsonb NOT NULL,
        spool_bytes bigint NOT NULL,
        spool_oldest_at timestamptz,
        sent_at timestamptz NOT NULL
      );
    `,
    version: 5,
  },
  {
    // Generation ids are random from here on (ADR-0013): a sequence goes
    // back with a restored backup and would reissue ids Collectors still hold.
    sql: 'ALTER TABLE transcript_generations ALTER COLUMN id DROP IDENTITY',
    version: 6,
  },
  {
    // Each System's mirror of the records its Collector holds (ADR-0011).
    // `record_sets` holds the latest set a Report carried: when it was sent
    // and received, the rows the Collector could not read, and, for a set too
    // large to send, its size with no records. `mirrored_records` holds the
    // readable records, each as the provisioner recorded it. A System with no
    // `record_sets` row has never sent a set. `sent_at` keeps an older Report
    // from replacing a newer set.
    sql: `
      CREATE TABLE record_sets (
        system text PRIMARY KEY REFERENCES systems (name),
        sent_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL,
        unreadable jsonb NOT NULL DEFAULT '[]',
        over_budget_bytes bigint
      );

      CREATE TABLE mirrored_records (
        system text NOT NULL REFERENCES systems (name),
        kind text NOT NULL,
        name text NOT NULL,
        record jsonb NOT NULL,
        PRIMARY KEY (system, kind, name)
      );
    `,
    version: 7,
  },
  {
    // Each System's time zone and the latest runs of its jobs. `time_zone` is
    // the IANA name its Collector last reported, null until one does. `run_sets`
    // holds the latest runs a Report carried the way `record_sets` holds a set
    // of records: when they were sent and received, the jobs the Collector or
    // the Hub could not read, and, for runs too large to send, their size with
    // no jobs. `mirrored_runs` holds each readable job's latest run and its
    // latest success, null for a job that has not succeeded. A System with no
    // `run_sets` row has never sent runs. `sent_at` keeps an older Report from
    // replacing newer runs.
    sql: `
      ALTER TABLE systems ADD COLUMN time_zone text;

      CREATE TABLE run_sets (
        system text PRIMARY KEY REFERENCES systems (name),
        sent_at timestamptz NOT NULL,
        received_at timestamptz NOT NULL,
        unreadable jsonb NOT NULL DEFAULT '[]',
        over_budget_bytes bigint
      );

      CREATE TABLE mirrored_runs (
        system text NOT NULL REFERENCES systems (name),
        job text NOT NULL,
        latest_run jsonb NOT NULL,
        latest_success jsonb,
        PRIMARY KEY (system, job)
      );
    `,
    version: 8,
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
