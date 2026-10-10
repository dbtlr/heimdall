import type { JobRuns, MirroredRecord, RecordRef, RecordsRead } from '@heimdall/schema';
import type { SQL } from 'bun';

type SetRow = {
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

// One System's entry in the read: its records, latest runs, and time zone.
const entryOf = (row: SetRow, records: MirroredRecord[], jobs: JobRuns[]): Entry => ({
  ...recordsOf(row, records),
  runs: runsOf(row, jobs),
  system: row.name,
  timeZone: row.time_zone,
});

// Every System the dashboard lists, by name, with the records and latest runs
// its Collector last sent, and its time zone. One read-only snapshot keeps each
// System's records and runs consistent with their sets. Systems come in the
// order the dashboard lists them.
export const readRecords = (sql: SQL): Promise<Entry[]> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const sets: SetRow[] = await tx`
      SELECT s.name, s.time_zone,
             r.sent_at, r.received_at, r.unreadable, r.over_budget_bytes,
             u.sent_at AS runs_sent_at, u.received_at AS runs_received_at,
             u.unreadable AS runs_unreadable, u.over_budget_bytes AS runs_over_budget_bytes
      FROM systems s
      LEFT JOIN record_sets r ON r.system = s.name
      LEFT JOIN run_sets u ON u.system = s.name
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
