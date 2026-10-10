import type {
  FileCheck,
  JobRuns,
  MirroredRecord,
  RecordRef,
  RecordsRead,
  ServiceCheck,
} from '@heimdall/schema';
import type { SQL } from 'bun';

import { compareCodeUnits } from './compare.ts';

type SetRow = {
  // `since` is in epoch milliseconds, as the Hub stores it.
  check_file_records: { digest: string; record: string }[] | null;
  check_files: FileCheck[] | null;
  check_files_over_budget_bytes: string | null;
  check_received_at: Date | null;
  check_sent_at: Date | null;
  check_services: ServiceCheck[] | null;
  check_services_over_budget_bytes: string | null;
  name: string;
  over_budget_bytes: string | null;
  received_at: Date | null;
  runs_over_budget_bytes: string | null;
  runs_received_at: Date | null;
  runs_sent_at: Date | null;
  runs_unreadable: string[] | null;
  sent_at: Date | null;
  time_zone: string | null;
  unreadable: RecordRef[] | null;
};

type RecordRow = { entry: MirroredRecord; system: string };

type RunRow = { entry: JobRuns; system: string };

type Entry = RecordsRead['systems'][number];

type Runs = Entry['runs'];

type Checks = Entry['checks'];

// One System's records fields in the read, from its set row and its records.
const recordsOf = (row: SetRow, records: MirroredRecord[]) => {
  if (row.sent_at === null || row.received_at === null) {
    return { records: null };
  }
  const times = {
    receivedAt: row.received_at.toISOString(),
    sentAt: row.sent_at.toISOString(),
  };
  if (row.over_budget_bytes !== null) {
    return { ...times, overBudget: { bytes: Number(row.over_budget_bytes) } };
  }
  return { ...times, records, unreadable: row.unreadable ?? [] };
};

// One System's latest runs in the read, from its runs row and its jobs, or
// null when no Report has carried runs.
const runsOf = (row: SetRow, jobs: JobRuns[]): Runs => {
  if (row.runs_sent_at === null || row.runs_received_at === null) {
    return null;
  }
  const times = {
    receivedAt: row.runs_received_at.toISOString(),
    sentAt: row.runs_sent_at.toISOString(),
  };
  if (row.runs_over_budget_bytes !== null) {
    return { ...times, overBudget: { bytes: Number(row.runs_over_budget_bytes) } };
  }
  return { ...times, jobs, unreadable: row.runs_unreadable ?? [] };
};

// The part of a System's checks that was too large to send, by part, with its size.
const overBudgetOf = (row: SetRow) => {
  const files = row.check_files_over_budget_bytes;
  const services = row.check_services_over_budget_bytes;
  return files === null && services === null
    ? {}
    : {
        overBudget: {
          ...(files === null ? {} : { files: { bytes: Number(files) } }),
          ...(services === null ? {} : { services: { bytes: Number(services) } }),
        },
      };
};

// One System's latest checks in the read, from its checks row, or null when no
// Report has carried checks. A part over budget is left out and named in
// `overBudget`, and so is `services` when the Report carried no services part.
// Digests sort by record, files by record, then path, and Service checks by
// service, then check, by code unit like records and runs.
const checksOf = (row: SetRow): Checks => {
  if (row.check_sent_at === null || row.check_received_at === null) {
    return null;
  }
  const times = {
    receivedAt: row.check_received_at.toISOString(),
    sentAt: row.check_sent_at.toISOString(),
  };
  const files = (row.check_files ?? [])
    .map(({ path, record, since, state }) => ({
      path,
      record,
      since: new Date(since).toISOString(),
      state,
    }))
    .toSorted((a, b) => compareCodeUnits(a.record, b.record) || compareCodeUnits(a.path, b.path));
  const fileRecords = (row.check_file_records ?? [])
    .map(({ digest, record }) => ({ digest, record }))
    .toSorted((a, b) => compareCodeUnits(a.record, b.record));
  const services = (row.check_services ?? [])
    .map(({ check, detail, service, since, state }) => ({
      check,
      detail,
      service,
      since: new Date(since).toISOString(),
      state,
    }))
    .toSorted(
      (a, b) => compareCodeUnits(a.service, b.service) || compareCodeUnits(a.check, b.check),
    );
  return {
    ...times,
    ...overBudgetOf(row),
    ...(row.check_files_over_budget_bytes === null ? { fileRecords, files } : {}),
    ...(row.check_services === null ? {} : { services }),
  };
};

// One System's entry in the read: its records, latest checks and runs, and time zone.
const entryOf = (row: SetRow, records: MirroredRecord[], jobs: JobRuns[]): Entry => ({
  ...recordsOf(row, records),
  checks: checksOf(row),
  runs: runsOf(row, jobs),
  system: row.name,
  timeZone: row.time_zone,
});

// Every System the dashboard lists, by name, with the records, latest runs, and
// latest checks its Collector last sent, and its time zone. One read-only snapshot keeps each
// System's records and runs consistent with their sets. Systems come in the
// order the dashboard lists them.
export const readRecords = (sql: SQL): Promise<Entry[]> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const sets: SetRow[] = await tx`
      SELECT s.name, s.time_zone,
             r.sent_at, r.received_at, r.unreadable, r.over_budget_bytes,
             u.sent_at AS runs_sent_at, u.received_at AS runs_received_at,
             u.unreadable AS runs_unreadable, u.over_budget_bytes AS runs_over_budget_bytes,
             c.sent_at AS check_sent_at, c.received_at AS check_received_at,
             c.files AS check_files, c.file_records AS check_file_records,
             c.files_over_budget_bytes AS check_files_over_budget_bytes,
             c.services AS check_services,
             c.services_over_budget_bytes AS check_services_over_budget_bytes
      FROM systems s
      LEFT JOIN record_sets r ON r.system = s.name
      LEFT JOIN run_sets u ON u.system = s.name
      LEFT JOIN check_sets c ON c.system = s.name
      ORDER BY s.name
    `;
    const rows: RecordRow[] = await tx`
      SELECT system, jsonb_build_object('kind', kind, 'name', name, 'record', record) AS entry
      FROM mirrored_records
      ORDER BY kind COLLATE "C", name COLLATE "C"
    `;
    const runRows: RunRow[] = await tx`
      SELECT system,
             jsonb_build_object('job', job, 'latestRun', latest_run,
                                'latestSuccess', latest_success) AS entry
      FROM mirrored_runs
      ORDER BY job COLLATE "C"
    `;
    const recordsBySystem = Map.groupBy(rows, (row) => row.system);
    const runsBySystem = Map.groupBy(runRows, (row) => row.system);
    return sets.map((row) =>
      entryOf(
        row,
        (recordsBySystem.get(row.name) ?? []).map((r) => r.entry),
        (runsBySystem.get(row.name) ?? []).map((r) => r.entry),
      ),
    );
  });
