import type { MirroredRecord, RecordRef, RecordsRead } from '@heimdall/schema';
import type { SQL } from 'bun';

type SetRow = {
  name: string;
  over_budget_bytes: string | null;
  received_at: Date | null;
  sent_at: Date | null;
  unreadable: RecordRef[] | null;
};

type RecordRow = { entry: MirroredRecord; system: string };

type Entry = RecordsRead['systems'][number];

// One System's entry in the read, from its set row and its records.
const entryOf = (row: SetRow, records: MirroredRecord[]): Entry => {
  if (row.sent_at === null || row.received_at === null) {
    return { records: null, system: row.name };
  }
  const times = {
    receivedAt: row.received_at.toISOString(),
    sentAt: row.sent_at.toISOString(),
    system: row.name,
  };
  if (row.over_budget_bytes !== null) {
    return { ...times, overBudget: { bytes: Number(row.over_budget_bytes) } };
  }
  return { ...times, records, unreadable: row.unreadable ?? [] };
};

// Every System the dashboard lists, by name, with the records its Collector
// last sent. One read-only snapshot keeps each System's records consistent
// with its set. The "C" collation keeps the order the same on every server.
export const readRecords = (sql: SQL): Promise<Entry[]> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const sets: SetRow[] = await tx`
      SELECT s.name, r.sent_at, r.received_at, r.unreadable, r.over_budget_bytes
      FROM systems s
      LEFT JOIN record_sets r ON r.system = s.name
      ORDER BY s.name COLLATE "C"
    `;
    const rows: RecordRow[] = await tx`
      SELECT system, jsonb_build_object('kind', kind, 'name', name, 'record', record) AS entry
      FROM mirrored_records
      ORDER BY kind COLLATE "C", name COLLATE "C"
    `;
    const bySystem = Map.groupBy(rows, (row) => row.system);
    return sets.map((row) =>
      entryOf(
        row,
        (bySystem.get(row.name) ?? []).map((r) => r.entry),
      ),
    );
  });
