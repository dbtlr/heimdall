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
];

// Serializes Hubs that start against the same database at once. The name is
// arbitrary; it only has to be the same for every Hub.
const MIGRATION_LOCK = 'heimdall-migrations';

// Brings the database to the latest version in one transaction and answers the
// versions it applied, oldest first.
export const migrate = (sql: SQL): Promise<number[]> =>
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
    for (const migration of MIGRATIONS) {
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
