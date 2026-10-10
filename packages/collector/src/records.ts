import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { RECORD_KINDS, RECORD_SCHEMAS, RunRecordSchema } from '@heimdall/schema';
import type { RecordKind, RecordOf, RunRecord } from '@heimdall/schema';

import { parseJson } from './json.ts';

// How long a job's runs are kept: older ones are pruned when a run is recorded.
export const RUN_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

// A record read back. The kind says which fields `record` has.
export type StoredRecord = { kind: RecordKind; name: string; record: RecordOf<RecordKind> };

export type StoredRun = { job: string; run: RunRecord };

// What `putRun` did with a run.
export type RunOutcome =
  // The run is kept.
  | 'kept'
  // The run started more than 90 days ago and is not the job's latest success, so it was pruned at once.
  | 'expired'
  // No job record of that name exists, so nothing was kept.
  | 'no job';

// Rows this build cannot read: written by a newer Collector, or damaged. The
// kind of a record is a string, since it may be one this build does not know.
export type Unreadable = {
  records: { kind: string; name: string }[];
  runs: { job: string; started: string }[];
};

// What a provisioner recorded on this System: the records by kind and name,
// and each job's runs by job and start time, oldest first (ADR-0011).
export type RecordStore = {
  close: () => void;
  // Removes a record, and a job's runs with it. False when nothing was recorded.
  forget: (kind: RecordKind, name: string) => boolean;
  // Keeps a record the caller checked against the schema of its kind, replacing
  // the one of the same kind and name.
  put: <K extends RecordKind>(kind: K, record: RecordOf<K>) => void;
  // Keeps a run of a recorded job, replacing the one with the same start, then
  // prunes the job's runs.
  putRun: (job: string, run: RunRecord) => RunOutcome;
  // Every record and run, read in one transaction so they agree. A row this
  // build cannot read is listed as unreadable, so the caller can say so instead
  // of letting it vanish.
  read: () => { records: StoredRecord[]; runs: StoredRun[]; unreadable: Unreadable };
  // A number that differs from its last value after another connection, such as
  // a `record` process, committed a write to the database. This connection's
  // own writes do not change it, so only a daemon that never writes can use it
  // to spot changes cheaply.
  version: () => number;
};

type RecordRow = { body: string; kind: string; name: string };
type RunRow = { body: string; job: string; started: string };

// Opens the store in `stateDir`, creating the directory private to its owner and
// the database when they are missing. `heimdall-collector run` may hold the
// database open while `record` and `forget` run as separate processes, so
// writes wait out each other's locks. `now` is the clock for pruning, in epoch milliseconds.
export const openRecords = async ({
  now = Date.now,
  stateDir,
}: {
  now?: () => number;
  stateDir: string;
}): Promise<RecordStore> => {
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  const db = new Database(join(stateDir, 'records.sqlite'), { create: true, strict: true });
  try {
    return storeOver(db, now);
  } catch (error) {
    // A file that is not a database, or whose tables have another shape, must
    // not leave a handle open for each retry.
    db.close();
    throw error;
  }
};

// The store over an open database, creating its tables when they are missing.
const storeOver = (db: Database, now: () => number): RecordStore => {
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA journal_mode = WAL');
  db.run(
    'CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, name))',
  );
  // `startedMs` is the start as epoch milliseconds, so pruning compares times, not text.
  db.run(
    'CREATE TABLE IF NOT EXISTS runs (job TEXT NOT NULL, started TEXT NOT NULL, startedMs INTEGER NOT NULL, exitStatus INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (job, started))',
  );

  const upsert = db.query(
    'INSERT OR REPLACE INTO records (kind, name, body) VALUES ($kind, $name, $body)',
  );
  const remove = db.query('DELETE FROM records WHERE kind = $kind AND name = $name');
  const removeRuns = db.query('DELETE FROM runs WHERE job = $job');
  const hasJob = db.query("SELECT 1 FROM records WHERE kind = 'job' AND name = $job");
  const upsertRun = db.query(
    'INSERT OR REPLACE INTO runs (job, started, startedMs, exitStatus, body) VALUES ($job, $started, $startedMs, $exitStatus, $body)',
  );
  // `IS NOT` matches every row when the job has no success, where `!=` would match none.
  const prune = db.query(
    'DELETE FROM runs WHERE job = $job AND startedMs < $cutoff AND startedMs IS NOT (SELECT max(startedMs) FROM runs WHERE job = $job AND exitStatus = 0)',
  );
  const selectRecords = db.query<RecordRow, []>(
    'SELECT kind, name, body FROM records ORDER BY kind, name',
  );
  const selectRuns = db.query<RunRow, []>(
    'SELECT job, started, body FROM runs ORDER BY job, startedMs',
  );
  const dataVersion = db.query<{ data_version: number }, []>('PRAGMA data_version');
  const isKept = db.query('SELECT 1 FROM runs WHERE job = $job AND started = $started');

  const forget = db.transaction((kind: RecordKind, name: string) => {
    const { changes } = remove.run({ kind, name });
    if (kind === 'job') {
      removeRuns.run({ job: name });
    }
    return changes > 0;
  });
  const putRun = db.transaction((job: string, run: RunRecord): RunOutcome => {
    if (hasJob.get({ job }) === null) {
      return 'no job';
    }
    upsertRun.run({
      body: JSON.stringify(run),
      exitStatus: run.exitStatus,
      job,
      started: run.started,
      startedMs: Date.parse(run.started),
    });
    prune.run({ cutoff: now() - RUN_RETENTION_DAYS * DAY_MS, job });
    return isKept.get({ job, started: run.started }) === null ? 'expired' : 'kept';
  });
  const read = db.transaction(() => {
    const records: StoredRecord[] = [];
    const unreadableRecords: Unreadable['records'] = [];
    for (const row of selectRecords.all()) {
      const kind = RECORD_KINDS.find((known) => known === row.kind);
      const parsed =
        kind === undefined ? undefined : RECORD_SCHEMAS[kind].safeParse(parseJson(row.body));
      if (kind === undefined || parsed?.success !== true) {
        unreadableRecords.push({ kind: row.kind, name: row.name });
      } else {
        records.push({ kind, name: row.name, record: parsed.data });
      }
    }
    const runs: StoredRun[] = [];
    const unreadableRuns: Unreadable['runs'] = [];
    for (const row of selectRuns.all()) {
      const parsed = RunRecordSchema.safeParse(parseJson(row.body));
      if (parsed.success) {
        runs.push({ job: row.job, run: parsed.data });
      } else {
        unreadableRuns.push({ job: row.job, started: row.started });
      }
    }
    return { records, runs, unreadable: { records: unreadableRecords, runs: unreadableRuns } };
  });

  return {
    close: () => db.close(),
    // Immediate transactions take the write lock at once, so two processes wait
    // for each other instead of failing on a lock upgrade.
    forget: (kind, name) => forget.immediate(kind, name),
    put: (kind, record) => {
      upsert.run({ body: JSON.stringify(record), kind, name: record.name });
    },
    putRun: (job, run) => putRun.immediate(job, run),
    read: () => read(),
    version: () => dataVersion.get()?.data_version ?? 0,
  };
};
