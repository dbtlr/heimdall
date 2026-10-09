import { Database } from 'bun:sqlite';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ApplicationRecordSchema,
  FilesRecordSchema,
  JobRecordSchema,
  RunRecordSchema,
  ServiceRecordSchema,
} from '@heimdall/schema';
import type { RecordKind, RecordOf, RunRecord } from '@heimdall/schema';

import { parseJson } from './json.ts';
import type { Checker } from './json.ts';

// How long a job's runs are kept: older ones are pruned when a run is recorded.
export const RUN_RETENTION_DAYS = 90;

const DAY_MS = 86_400_000;

// A record read back, with the kind that says which fields it has.
export type StoredRecordOf<K extends RecordKind> = {
  kind: K;
  name: string;
  record: RecordOf<K>;
};
export type StoredRecord = { [K in RecordKind]: StoredRecordOf<K> }[RecordKind];

export type StoredRun = { job: string; run: RunRecord };

// What a provisioner recorded on this System: the records by kind and name,
// and each job's runs by job and start time, oldest first (ADR-0011).
export type RecordStore = {
  close: () => void;
  // Removes a record, and a job's runs with it. False when nothing was recorded.
  forget: (kind: RecordKind, name: string) => boolean;
  // Keeps a record, replacing the one of the same kind and name.
  put: <K extends RecordKind>(kind: K, record: RecordOf<K>) => void;
  // Keeps a run of a recorded job, replacing the one with the same start, then
  // prunes the job's runs. False, keeping nothing, when no job record of that name exists.
  putRun: (job: string, run: RunRecord) => boolean;
  // Every record and run. A row this build cannot read is left out.
  read: () => { records: StoredRecord[]; runs: StoredRun[] };
};

type RecordRow = { body: string; name: string };
type RunRow = { body: string; job: string };

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
  const selectRecords = db.query<RecordRow, { kind: RecordKind }>(
    'SELECT name, body FROM records WHERE kind = $kind ORDER BY name',
  );
  // The records of one kind, leaving out a row this build cannot read.
  const readKind = <K extends RecordKind>(
    kind: K,
    schema: Checker<RecordOf<K>>,
  ): StoredRecordOf<K>[] =>
    selectRecords.all({ kind }).flatMap((row) => {
      const parsed = schema.safeParse(parseJson(row.body));
      return parsed.success ? [{ kind, name: row.name, record: parsed.data }] : [];
    });
  const selectRuns = db.query<RunRow, []>('SELECT job, body FROM runs ORDER BY job, startedMs');

  const forget = db.transaction((kind: RecordKind, name: string) => {
    const { changes } = remove.run({ kind, name });
    if (kind === 'job') {
      removeRuns.run({ job: name });
    }
    return changes > 0;
  });
  const putRun = db.transaction((job: string, run: RunRecord) => {
    if (hasJob.get({ job }) === null) {
      return false;
    }
    upsertRun.run({
      body: JSON.stringify(run),
      exitStatus: run.exitStatus,
      job,
      started: run.started,
      startedMs: Date.parse(run.started),
    });
    prune.run({ cutoff: now() - RUN_RETENTION_DAYS * DAY_MS, job });
    return true;
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
    read: () => ({
      records: [
        ...readKind('application', ApplicationRecordSchema),
        ...readKind('service', ServiceRecordSchema),
        ...readKind('job', JobRecordSchema),
        ...readKind('files', FilesRecordSchema),
      ],
      runs: selectRuns.all().flatMap((row) => {
        const parsed = RunRecordSchema.safeParse(parseJson(row.body));
        return parsed.success ? [{ job: row.job, run: parsed.data }] : [];
      }),
    }),
  };
};
