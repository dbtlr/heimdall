import { setTimeout as delay } from 'node:timers/promises';

import type { SQL } from 'bun';

import { MIGRATIONS, migrate } from './migrations.ts';

const LOCK_NOT_AVAILABLE = '55P03';
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;
const HOLDER_LOG_INTERVAL_MS = 60_000;
const HOLDERS_LISTED = 5;

// A session that holds a lock on one of the Hub's tables, or an advisory lock.
// The activity fields are empty when the Hub's role may not see that session.
export type LockHolder = {
  applicationName: string | null;
  locked: string;
  pid: number;
  since: Date | null;
  state: string | null;
};

// Whether `error` is PostgreSQL's lock_not_available, which Bun reports in `errno`.
const isLockNotAvailable = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'errno' in error &&
  error.errno === LOCK_NOT_AVAILABLE;

// How long to wait after the `attempt`th failed try (from 0): one second,
// doubling, to a cap of thirty.
export const backoffMs = (attempt: number): number =>
  Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_CAP_MS);

// A gate that opens at most once per `intervalMs`: the first call answers true,
// and later ones answer true only after the interval has passed since the last true.
export const oncePerInterval = (intervalMs: number, now: () => number): (() => boolean) => {
  let last: number | undefined;
  return () => {
    const at = now();
    if (last !== undefined && at - last < intervalMs) {
      return false;
    }
    last = at;
    return true;
  };
};

// The other sessions holding a lock on a table in this database or an advisory
// lock, longest-open first, with sessions whose start the Hub's role cannot see
// last. Once the migration has rolled back, nothing says which of them blocked it,
// so this lists them all, which for a Hub's database is a backup, another Hub
// migrating, or a stuck session.
// PostgreSQL shows state and start time only for the Hub's own role's sessions or
// a role with pg_read_all_stats, so for other sessions those come back empty.
export const lockHolders = async (sql: SQL): Promise<LockHolder[]> => {
  const rows: {
    application_name: string | null;
    locked: string;
    pid: number;
    since: Date | null;
    state: string | null;
  }[] = await sql`
    SELECT
      l.pid,
      a.application_name,
      a.state,
      coalesce(a.xact_start, a.state_change) AS since,
      string_agg(DISTINCT coalesce(c.relname, 'advisory lock'), ', ') AS locked
    FROM pg_locks l
    LEFT JOIN pg_stat_activity a ON a.pid = l.pid
    LEFT JOIN pg_class c ON l.locktype = 'relation' AND c.oid = l.relation
    LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE l.granted
      AND l.pid <> pg_backend_pid()
      AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND (
        l.locktype = 'advisory'
        OR (c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema'))
      )
    GROUP BY l.pid, a.application_name, a.state, a.xact_start, a.state_change
    ORDER BY since NULLS LAST, l.pid
    LIMIT ${HOLDERS_LISTED}
  `;
  return rows.map((row) => ({
    applicationName: row.application_name === '' ? null : row.application_name,
    locked: row.locked,
    pid: row.pid,
    since: row.since,
    state: row.state,
  }));
};

const describeHolder = (holder: LockHolder): string => {
  const details = [
    holder.applicationName === null ? undefined : `application_name "${holder.applicationName}"`,
    [holder.state, holder.since === null ? undefined : `since ${holder.since.toISOString()}`]
      .filter((part) => part !== undefined && part !== null)
      .join(' '),
  ].filter((part) => part !== undefined && part !== '');
  const inParens = details.length === 0 ? '' : ` (${details.join(', ')})`;
  return `pid ${String(holder.pid)}${inParens} on ${holder.locked}`;
};

// The line logged while a migration waits for a lock.
export const describeLockWait = (holders: readonly LockHolder[]): string =>
  holders.length === 0
    ? 'Waiting for a database lock. Could not tell which session holds it. Retrying.'
    : `Waiting for a database lock. Held by ${holders.map(describeHolder).join('; ')}. Retrying.`;

// Runs `migrate`, and when another session's lock stalls it, rolls back, reports
// the holders to `onBlocked` at most once a minute, waits with backoff, and tries
// again until the migrations apply. Any other error rejects at once. A `signal`
// that aborts ends the wait with the lock error. `lockTimeoutMs`, `lookupHolders`,
// `now`, and `sleep` are for tests.
export const migrateWhenFree = async (
  sql: SQL,
  {
    lockTimeoutMs,
    lookupHolders = lockHolders,
    migrations = MIGRATIONS,
    now = Date.now,
    onBlocked,
    signal,
    sleep = async (ms) => {
      await delay(ms, undefined, signal === undefined ? {} : { signal }).catch(() => {});
    },
  }: {
    lockTimeoutMs?: number;
    lookupHolders?: (sql: SQL) => Promise<LockHolder[]>;
    migrations?: typeof MIGRATIONS;
    now?: () => number;
    onBlocked: (holders: LockHolder[]) => void | Promise<void>;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<number[]> => {
  const stopped = () => signal?.aborted === true;
  const mayLog = oncePerInterval(HOLDER_LOG_INTERVAL_MS, now);
  for (let attempt = 0; ; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each try follows the failure of the last.
      return await migrate(sql, migrations, lockTimeoutMs === undefined ? {} : { lockTimeoutMs });
    } catch (error) {
      if (!isLockNotAvailable(error) || stopped()) {
        throw error;
      }
      if (mayLog()) {
        // Naming the holder is a courtesy; failing to find it must not end the wait.
        // oxlint-disable-next-line no-await-in-loop -- reported before the wait.
        const holders = await lookupHolders(sql).catch((): LockHolder[] => []);
        // oxlint-disable-next-line no-await-in-loop -- reported before the wait.
        await onBlocked(holders);
      }
      // oxlint-disable-next-line no-await-in-loop -- the backoff is the point.
      await sleep(backoffMs(attempt));
      if (stopped()) {
        throw error;
      }
    }
  }
};
