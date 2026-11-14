import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  JobRunsSectionSchema,
  MAX_JOB_RUNS_PER_REPORT,
  RECORD_KINDS,
  RECORD_SCHEMAS,
  RunRecordSchema,
} from '@heimdall/schema';
import type { RecordKind, RecordOf, RunRecord, SentJobRun } from '@heimdall/schema';

import { parseJson } from './json.ts';

// How long a job's runs are kept: older ones are pruned when a run is recorded.
export const RUN_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

// A record read back. The kind says which fields `record` has.
export type StoredRecord = { kind: RecordKind; name: string; record: RecordOf<RecordKind> };

export type StoredRun = { job: string; run: RunRecord };

// One job's latest run, and its latest successful run, which may be the same
// run, or null when the job has none among the runs the Collector keeps.
export type LatestRuns = { job: string; latestRun: RunRecord; latestSuccess: RunRecord | null };

// What `putRun` did with a run.
export type RunOutcome =
  // The run is kept.
  | 'kept'
  // The run started more than 90 days ago and is not the job's latest success, so it was pruned at once.
  | 'expired'
  // No job record of that name exists, so nothing was kept.
  | 'no job';

// The runs the Hub has not taken, oldest first and at most one Report's worth,
// and how to settle them once a Report carrying them is delivered (ADR-0023).
// `skipped` lists the held runs the section cannot carry, which are no longer
// held, so the caller can say so.
export type HeldRuns = {
  runs: SentJobRun[];
  settle: () => void;
  skipped: { job: string; started: string }[];
};

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
  // Each job's latest runs, for the jobs that have any, by job name. The
  // database picks them, so a job holding 90 days of runs costs two rows, not
  // all of them. A job whose latest run or latest success this build cannot
  // read is listed as unreadable, so the caller can say so.
  latestRuns: () => { jobs: LatestRuns[]; unreadable: string[] };
  // Every record and run, read in one transaction so they agree. A row this
  // build cannot read is listed as unreadable, so the caller can say so instead
  // of letting it vanish.
  read: () => { records: StoredRecord[]; runs: StoredRun[]; unreadable: Unreadable };
  // The records alone, read as `read` reads them, without parsing any run.
  readRecords: () => { records: StoredRecord[]; unreadable: Unreadable['records'] };
  // The runs the Hub has not taken (ADR-0023), found through an index over the
  // held runs alone. Runs the job runs section cannot carry are left out and
  // no longer held until they are recorded again.
  heldRuns: () => HeldRuns;
  // Holds every kept run again, as pairing with a Hub does. It counts as a
  // change to each run, so a Report read before it settles none of them.
  holdAllRuns: () => void;
  // A number that differs from its last value after another connection, such as
  // a `record` process, committed a write to the database. This connection's
  // own writes do not change it, so a caller that writes, as the reporter does
  // when it settles job runs, must not rely on it to see those writes.
  version: () => number;
};

type RecordRow = { body: string; kind: string; name: string };
type RunRow = { body: string; job: string; started: string };
type HeldRow = RunRow & { revision: number };
type LatestRunsRow = { job: string; latest: string; success: string | null };

// Where the store keeps its database in `stateDir`.
export const recordsPath = (stateDir: string) => join(stateDir, 'records.sqlite');

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
  const db = new Database(recordsPath(stateDir), { create: true, strict: true });
  try {
    return storeOver(db, now);
  } catch (error) {
    // A file that is not a database, or whose tables have another shape, must
    // not leave a handle open for each retry.
    db.close();
    throw error;
  }
};

// Adds a column to a table made before it existed. Two processes may open the
// store together, so a column the other added first is not an error.
const addColumn = (db: Database, table: string, column: string, definition: string) => {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (columns.some(({ name }) => name === column)) {
    return;
  }
  try {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error) {
    if (!String(error).includes('duplicate column')) {
      throw error;
    }
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

  // `revision` counts the changes to a run, pairing included, and `settled` is
  // the revision the Hub last took, so a run is held while `revision > settled`,
  // and one recorded again, or held again by pairing, after a Report read it is
  // sent again (ADR-0023). Runs kept
  // before these columns existed have revision 1 and settled 0, so they are held.
  addColumn(db, 'runs', 'revision', 'INTEGER NOT NULL DEFAULT 1');
  addColumn(db, 'runs', 'settled', 'INTEGER NOT NULL DEFAULT 0');
  db.run(
    'CREATE INDEX IF NOT EXISTS runs_held ON runs (startedMs, job, started) WHERE revision > settled',
  );

  // The two lookups of `latestRuns`: the latest run of a job, and its latest
  // success, which the partial index serves.
  db.run('CREATE INDEX IF NOT EXISTS runs_latest ON runs (job, startedMs)');
  db.run(
    'CREATE INDEX IF NOT EXISTS runs_latest_success ON runs (job, startedMs) WHERE exitStatus = 0',
  );

  const upsert = db.query(
    'INSERT OR REPLACE INTO records (kind, name, body) VALUES ($kind, $name, $body)',
  );
  const remove = db.query('DELETE FROM records WHERE kind = $kind AND name = $name');
  const removeRuns = db.query('DELETE FROM runs WHERE job = $job');
  const hasJob = db.query("SELECT 1 FROM records WHERE kind = 'job' AND name = $job");
  const upsertRun = db.query(
    `INSERT INTO runs (job, started, startedMs, exitStatus, body) VALUES ($job, $started, $startedMs, $exitStatus, $body)
    ON CONFLICT (job, started) DO UPDATE SET startedMs = excluded.startedMs, exitStatus = excluded.exitStatus,
      body = excluded.body, revision = revision + 1`,
  );
  const selectHeld = db.query<HeldRow, []>(
    `SELECT job, started, body, revision FROM runs WHERE revision > settled
    ORDER BY startedMs, job, started LIMIT ${String(MAX_JOB_RUNS_PER_REPORT)}`,
  );
  // Settles a run only while it holds the body that was read, since `forget`
  // and `record` may replace it with another at the same revision.
  const settleRun = db.query(
    'UPDATE runs SET settled = $revision WHERE job = $job AND started = $started AND body = $body',
  );
  const holdAll = db.query('UPDATE runs SET revision = revision + 1');
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
  const selectLatestRuns = db.query<LatestRunsRow, []>(
    `SELECT job,
      (SELECT body FROM runs WHERE job = jobs.job ORDER BY startedMs DESC LIMIT 1) AS latest,
      (SELECT body FROM runs WHERE job = jobs.job AND exitStatus = 0 ORDER BY startedMs DESC LIMIT 1) AS success
    FROM (SELECT DISTINCT job FROM runs) AS jobs
    ORDER BY job`,
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
  const readRecords = () => {
    const records: StoredRecord[] = [];
    const unreadable: Unreadable['records'] = [];
    for (const row of selectRecords.all()) {
      const kind = RECORD_KINDS.find((known) => known === row.kind);
      const parsed =
        kind === undefined ? undefined : RECORD_SCHEMAS[kind].safeParse(parseJson(row.body));
      if (kind === undefined || parsed?.success !== true) {
        unreadable.push({ kind: row.kind, name: row.name });
      } else {
        records.push({ kind, name: row.name, record: parsed.data });
      }
    }
    return { records, unreadable };
  };
  const read = db.transaction(() => {
    const { records, unreadable: unreadableRecords } = readRecords();
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
  const settleAll = db.transaction((rows: readonly HeldRow[]) => {
    for (const { body, job, revision, started } of rows) {
      settleRun.run({ body, job, revision, started });
    }
  });
  // A held run that is no longer a run the section can carry is settled at
  // once, so it never takes one of the section's places.
  const heldRuns = (): HeldRuns => {
    const skipped: HeldRuns['skipped'] = [];
    // Skipped runs leave their places to the held runs behind them, so look
    // again until a page carries a run or the held runs are gone.
    for (;;) {
      const runs: SentJobRun[] = [];
      const settling: HeldRow[] = [];
      const skippedRows: HeldRow[] = [];
      const rows = selectHeld.all();
      for (const row of rows) {
        const { job, started } = row;
        const parsed = RunRecordSchema.safeParse(parseJson(row.body));
        const sent = parsed.success
          ? JobRunsSectionSchema.safeParse({ runs: [{ ...parsed.data, job }] })
          : undefined;
        // A body whose start is not its key would be sent as another run.
        if (parsed.success && sent?.success === true && parsed.data.started === started) {
          runs.push(...sent.data.runs);
          settling.push(row);
        } else {
          skipped.push({ job, started });
          skippedRows.push(row);
        }
      }
      settleAll(skippedRows);
      if (runs.length > 0 || skippedRows.length === 0) {
        return { runs, settle: () => settleAll(settling), skipped };
      }
    }
  };
  const latestRuns = () => {
    const jobs: LatestRuns[] = [];
    const unreadable: string[] = [];
    for (const row of selectLatestRuns.all()) {
      const latest = RunRecordSchema.safeParse(parseJson(row.latest));
      const success =
        row.success === null ? undefined : RunRecordSchema.safeParse(parseJson(row.success));
      if (!latest.success || success?.success === false) {
        unreadable.push(row.job);
      } else {
        jobs.push({ job: row.job, latestRun: latest.data, latestSuccess: success?.data ?? null });
      }
    }
    return { jobs, unreadable };
  };

  return {
    close: () => db.close(),
    // Immediate transactions take the write lock at once, so two processes wait
    // for each other instead of failing on a lock upgrade.
    forget: (kind, name) => forget.immediate(kind, name),
    heldRuns,
    holdAllRuns: () => {
      holdAll.run();
    },
    latestRuns,
    put: (kind, record) => {
      upsert.run({ body: JSON.stringify(record), kind, name: record.name });
    },
    putRun: (job, run) => putRun.immediate(job, run),
    read: () => read(),
    readRecords,
    version: () => dataVersion.get()?.data_version ?? 0,
  };
};
