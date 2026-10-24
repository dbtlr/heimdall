import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { MAX_SERVICE_STOPS_PER_REPORT } from '@heimdall/schema';
import type { SentServiceStop } from '@heimdall/schema';

// How long a logged stop the Hub has not taken is kept after it last changed,
// and how many are kept
// per Service, so a Hub out of reach for days costs a bounded log (ADR-0021).
export const STOP_LOG_DAYS = 7;
export const MAX_STOPS_PER_SERVICE = 1000;

const DAY_MS = 86_400_000;

// What a supervisor holds about one Service at one check: whether it is
// running, when it last entered and left its running state, the automatic
// restarts it counted, and how its last run ended. A time or a word the
// supervisor does not hold is null.
export type StopFacts = {
  exitStatus: number | null;
  restarts: number;
  result: string | null;
  running: boolean;
  startedAt: number | null;
  stoppedAt: number | null;
};

// A page of the log the Hub has not taken, and how to settle it once a Report
// carrying it is delivered.
export type PendingStops = { settle: () => void; stops: SentServiceStop[] };

// The Service stops the Collector logged, and the baseline it compares each
// check with, per Service and per boot (ADR-0021). A Service is named by `key`,
// which changes when it is recorded under another supervisor or target, and by
// `service`, its record's name, which the stops carry.
export type StopLog = {
  close: () => void;
  // Compares one check's facts with the Service's baseline, logs the stop they
  // show, if any, and makes them the baseline. A Service with no baseline, or
  // one from another boot, gets a fresh baseline and no stop.
  observe: (check: { boot: string; facts: StopFacts; key: string; service: string }) => void;
  // The stops not yet taken, oldest first, at most one Report's worth.
  pending: () => PendingStops;
  // Forgets the baseline of every Service but those named, ending the stop each
  // forgotten one had under way with no known end.
  retain: (keys: readonly string[]) => void;
};

type BaselineRow = {
  boot: string;
  openStop: number | null;
  restarts: number;
  stoppedAt: number | null;
};

type StopRow = SentServiceStop & { id: number; ongoing: number; revision: number };

// Opens the log in `stateDir`, apart from the records, since a stop is what
// the Collector observed and not what a provisioner recorded (ADR-0011). `now`
// is the clock for pruning, in epoch milliseconds.
export const openStopLog = async ({
  now = Date.now,
  stateDir,
}: {
  now?: () => number;
  stateDir: string;
}): Promise<StopLog> => {
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  const db = new Database(join(stateDir, 'stops.sqlite'), { create: true, strict: true });
  try {
    return logOver(db, now);
  } catch (error) {
    db.close();
    throw error;
  }
};

// `revision` counts the changes to a stop, and `settled` is the revision the
// Hub last took, so a stop that changes after a Report carried it is sent again.
// `changed_at` is when it last changed, on the Collector's clock, which ages it,
// so a long stop that just ended is kept until the Hub learns of its end.
const logOver = (db: Database, now: () => number): StopLog => {
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA journal_mode = WAL');
  db.run(
    'CREATE TABLE IF NOT EXISTS baselines (key TEXT PRIMARY KEY, boot TEXT NOT NULL, stopped_at INTEGER, restarts INTEGER NOT NULL, open_stop INTEGER)',
  );
  db.run(
    'CREATE TABLE IF NOT EXISTS stops (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, service TEXT NOT NULL, stopped_at INTEGER NOT NULL, started_at INTEGER, ongoing INTEGER NOT NULL, restarts INTEGER NOT NULL, result TEXT, exit_status INTEGER, revision INTEGER NOT NULL, settled INTEGER NOT NULL DEFAULT 0, changed_at INTEGER NOT NULL)',
  );

  // The Hub names a stop by its Service and `stoppedAt`, and refuses a Report
  // that sends one twice, so the log holds one stop per name. A Docker
  // container's name can point back to a container whose stop is already
  // logged, which is that stop seen again.
  db.run(
    'DELETE FROM stops WHERE id NOT IN (SELECT MAX(id) FROM stops GROUP BY service, stopped_at)',
  );
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS stops_name ON stops (service, stopped_at)');

  const baselineOf = db.query<BaselineRow, { key: string }>(
    'SELECT boot, stopped_at AS stoppedAt, restarts, open_stop AS openStop FROM baselines WHERE key = $key',
  );
  const putBaseline = db.query(
    'INSERT OR REPLACE INTO baselines (key, boot, stopped_at, restarts, open_stop) VALUES ($key, $boot, $stoppedAt, $restarts, $openStop)',
  );
  const insertStop = db.query<{ id: number }, Record<string, number | string | null>>(
    `INSERT INTO stops (key, service, stopped_at, started_at, ongoing, restarts, result, exit_status, revision, changed_at)
      VALUES ($key, $service, $stoppedAt, $startedAt, $ongoing, $restarts, $result, $exitStatus, 1, $now)
    ON CONFLICT (service, stopped_at) DO UPDATE SET key = excluded.key, started_at = excluded.started_at,
      ongoing = excluded.ongoing, restarts = excluded.restarts, result = excluded.result,
      exit_status = excluded.exit_status, revision = revision + 1, changed_at = excluded.changed_at
    RETURNING id`,
  );
  // The facts of a check that saw the Service still stopped are its latest word
  // on how the stop went, and a check that saw it running again ends the stop
  // and keeps the word it had, since systemd forgets it on the new start. A
  // check that saw it stopped with no word, as a Docker container created to
  // replace one that ended, keeps the word too. A check that changes nothing
  // leaves the stop as it was, so it is not sent again.
  const extendStop = db.query(
    `UPDATE stops SET restarts = restarts + $restarts, revision = revision + 1, changed_at = $now,
      ongoing = $ongoing, started_at = $startedAt,
      result = CASE WHEN $ongoing = 1 AND $result IS NOT NULL THEN $result ELSE result END,
      exit_status = CASE WHEN $ongoing = 1 AND $exitStatus IS NOT NULL THEN $exitStatus ELSE exit_status END
    WHERE id = $id AND ($restarts > 0 OR ongoing IS NOT $ongoing OR started_at IS NOT $startedAt
      OR ($ongoing = 1 AND (($result IS NOT NULL AND result IS NOT $result)
        OR ($exitStatus IS NOT NULL AND exit_status IS NOT $exitStatus))))`,
  );
  const endUnknown = db.query(
    'UPDATE stops SET ongoing = 0, started_at = NULL, revision = revision + 1, changed_at = $now WHERE id = $id AND ongoing = 1',
  );
  const pruneService = db.query(
    `DELETE FROM stops WHERE key = $key AND ongoing = 0 AND id NOT IN
      (SELECT id FROM stops WHERE key = $key ORDER BY id DESC LIMIT ${String(MAX_STOPS_PER_SERVICE)})`,
  );
  const pruneOld = db.query('DELETE FROM stops WHERE ongoing = 0 AND changed_at < $cutoff');
  const selectPending = db.query<StopRow, []>(
    `SELECT id, service, stopped_at AS stoppedAt, started_at AS startedAt, ongoing, restarts,
      result, exit_status AS exitStatus, revision
    FROM stops WHERE revision > settled ORDER BY id LIMIT ${String(MAX_SERVICE_STOPS_PER_REPORT)}`,
  );
  const settleStop = db.query('UPDATE stops SET settled = $revision WHERE id = $id');
  const dropSettled = db.query('DELETE FROM stops WHERE ongoing = 0 AND settled = revision');
  const selectKeys = db.query<{ key: string; openStop: number | null }, []>(
    'SELECT key, open_stop AS openStop FROM baselines',
  );
  const removeBaseline = db.query('DELETE FROM baselines WHERE key = $key');

  // The stop a check's facts show against the baseline, logged or carried
  // into the stop under way, and the stop still under way after it.
  const logStop = (
    { facts, key, service }: { facts: StopFacts; key: string; service: string },
    baseline: BaselineRow,
  ): number | null => {
    const left = facts.stoppedAt !== null && facts.stoppedAt !== baseline.stoppedAt;
    // A lower count, as after `systemctl reset-failed`, is the new baseline.
    const restarts = Math.max(0, facts.restarts - baseline.restarts);
    const ranAgain =
      facts.running &&
      facts.startedAt !== null &&
      (facts.stoppedAt === null || facts.startedAt >= facts.stoppedAt);
    const ongoing = ranAgain ? 0 : 1;
    const startedAt = ranAgain ? facts.startedAt : null;
    if (baseline.openStop !== null) {
      extendStop.run({
        exitStatus: facts.exitStatus,
        id: baseline.openStop,
        now: now(),
        ongoing,
        restarts,
        result: facts.result,
        startedAt,
      });
      return ranAgain ? null : baseline.openStop;
    }
    if (!left) {
      return null;
    }
    const inserted = insertStop.get({
      exitStatus: ranAgain ? null : facts.exitStatus,
      key,
      now: now(),
      ongoing,
      restarts,
      result: ranAgain ? null : facts.result,
      service,
      startedAt,
      stoppedAt: facts.stoppedAt,
    });
    pruneService.run({ key });
    return ranAgain ? null : (inserted?.id ?? null);
  };

  const observe = db.transaction((check: Parameters<StopLog['observe']>[0]) => {
    const baseline = baselineOf.get({ key: check.key });
    let openStop: number | null = null;
    if (baseline === null || baseline.boot !== check.boot) {
      if (baseline?.openStop != null) {
        endUnknown.run({ id: baseline.openStop, now: now() });
      }
    } else {
      openStop = logStop(check, baseline);
    }
    putBaseline.run({
      boot: check.boot,
      key: check.key,
      openStop,
      restarts: check.facts.restarts,
      stoppedAt: check.facts.stoppedAt,
    });
  });

  const retain = db.transaction((keys: readonly string[]) => {
    const kept = new Set(keys);
    for (const { key, openStop } of selectKeys.all()) {
      if (!kept.has(key)) {
        if (openStop !== null) {
          endUnknown.run({ id: openStop, now: now() });
        }
        removeBaseline.run({ key });
      }
    }
  });

  const settle = db.transaction((rows: readonly { id: number; revision: number }[]) => {
    for (const { id, revision } of rows) {
      settleStop.run({ id, revision });
    }
    dropSettled.run();
  });

  return {
    close: () => db.close(),
    observe,
    pending: () => {
      pruneOld.run({ cutoff: now() - STOP_LOG_DAYS * DAY_MS });
      const rows = selectPending.all();
      return {
        settle: () => settle(rows),
        stops: rows.map(
          ({ exitStatus, ongoing, restarts, result, service, startedAt, stoppedAt }) => ({
            exitStatus,
            ongoing: ongoing === 1,
            restarts,
            result,
            service,
            startedAt,
            stoppedAt,
          }),
        ),
      };
    },
    retain,
  };
};

// The id of the boot the System is running, which changes at every boot, or
// undefined when it cannot be read.
export const linuxBootId = async (
  read: (path: string) => Promise<string> = (path) => Bun.file(path).text(),
): Promise<string | undefined> => {
  try {
    const id = (await read('/proc/sys/kernel/random/boot_id')).trim();
    return id === '' ? undefined : id;
  } catch {
    return undefined;
  }
};
