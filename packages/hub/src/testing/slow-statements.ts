import { SQL } from 'bun';

// What a database's other busy backends are doing and whom they wait for,
// the locks they wait on, and the planner's view of `tables`: how big it
// believes each is against how big it is, and when it last analyzed it.
const snapshot = async (sql: SQL, tables: string[]) => ({
  activity: [
    ...(await sql`
      SELECT pid, state, wait_event_type, wait_event, backend_xid::text, backend_xmin::text,
             query_start, pg_blocking_pids(pid) AS blocked_by, left(query, 400) AS query
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
    `),
  ],
  locks: [
    ...(await sql`
      SELECT pid, locktype, relation::regclass::text AS relation, mode FROM pg_locks
      WHERE NOT granted
        AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())
    `),
  ],
  tables: [
    ...(await sql`
      SELECT c.relname, c.reltuples, c.relpages,
             pg_relation_size(c.oid) / current_setting('block_size')::int AS pages_now,
             s.n_live_tup, s.n_mod_since_analyze, s.last_analyze, s.last_autoanalyze
      FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE c.relname = ANY (${tables}::text[])
    `),
  ],
});

// Answers `work`. If it has not settled after `ms`, first logs a snapshot of
// the database at `url` from a connection of its own, so a test that times
// out shows whether it waited on a lock or ran a plan its statistics misled
// (HMD-199).
export const diagnoseIfSlow = async <T>(
  url: URL,
  work: Promise<T>,
  { ms = 10_000, tables }: { ms?: number; tables: string[] },
): Promise<T> => {
  const dump = async () => {
    const sql = new SQL(url.href, { max: 1 });
    try {
      const seen = await snapshot(sql, tables);
      console.warn(`Still running after ${String(ms)} ms:\n${JSON.stringify(seen, null, 2)}`);
    } catch (error) {
      console.warn(`Could not read what the database was doing: ${String(error)}`);
    } finally {
      await sql.close();
    }
  };
  const timer = setTimeout(() => void dump(), ms);
  try {
    return await work;
  } finally {
    clearTimeout(timer);
  }
};
