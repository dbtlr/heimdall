import { FILE_CHECK_STATES, filesRecordDigest, REPORTED_RECORD_SCHEMAS } from '@heimdall/schema';
import type { SQL } from 'bun';
import { z } from 'zod';

import { compareCodeUnits } from './compare.ts';
import { clear, evaluateEach, raise } from './conditions.ts';
import type { ConditionKind } from './store.ts';

const DRIFT: ConditionKind = 'drift';

// What the Hub should do with one path's Drift: raise it with a reason (or
// update the reason of the open one), clear it, or leave it as it is because
// what decides it is unknown.
type Verdict = { raise: string } | 'clear' | 'unknown';

// The files that did not match, as the Hub stored them.
const StoredFilesSchema = z.array(
  z.object({
    path: z.string(),
    record: z.string(),
    since: z.number(),
    state: z.enum(FILE_CHECK_STATES),
  }),
);

// The files records the Collector hashed, each with the digest it read.
const StoredFileRecordsSchema = z.array(z.object({ digest: z.string(), record: z.string() }));

const UnreadableRecordsSchema = z.array(z.object({ kind: z.string(), name: z.string() }));

type FileCheck = z.infer<typeof StoredFilesSchema>[number];

type CheckSetRow = {
  file_records: unknown;
  files: unknown;
  over_budget_bytes: string | null;
};
type RecordSetRow = { over_budget_bytes: string | null; unreadable: unknown };
type MirroredRow = { name: string; record: unknown };

// A mirrored files record this Hub can read, with its digest.
type ReadableRecord = { digest: string; name: string; paths: Set<string> };

const reasonOf = ({ record, state }: Pick<FileCheck, 'record' | 'state'>) =>
  state === 'missing'
    ? `Missing: the file recorded in ${record} does not exist.`
    : `Changed: its content no longer matches the hash recorded in ${record}.`;

// What each path in the mirrored files records decides, and whether some files
// record is unreadable.
//
// The Collector's verdict on a record's files counts only when the checks list
// the record with the digest of the record this Hub mirrors, since the record
// and the checks reach the Hub apart and can describe different versions. For
// any other record every path it names is unknown. In a record the checks
// judged, a path listed as changed or missing is raised, one listed as
// unreadable is unknown, and one not listed matches. A path several records
// name is raised if any judged record shows it changed or missing, otherwise
// unknown if anything about it is unknown, and clear only when every record
// naming it was judged and shows it matching. The reason names the first
// record, by name, that shows the path changed or missing.
const verdictsOf = ({
  files,
  judged,
  records,
}: {
  files: readonly FileCheck[];
  judged: ReadonlyMap<string, string>;
  records: readonly ReadableRecord[];
}) => {
  const mismatched = new Map(files.map((file) => [JSON.stringify([file.record, file.path]), file]));
  const verdicts = new Map<string, Verdict>();
  const ordered = records.toSorted((a, b) => compareCodeUnits(a.name, b.name));
  for (const record of ordered) {
    const isJudged = judged.get(record.name) === record.digest;
    for (const path of record.paths) {
      const held = verdicts.get(path);
      const mismatch = mismatched.get(JSON.stringify([record.name, path]));
      verdicts.set(path, strongest(held, verdictOf({ isJudged, mismatch })));
    }
  }
  return verdicts;
};

// What one judged-or-not record says of one of its paths.
const verdictOf = ({
  isJudged,
  mismatch,
}: {
  isJudged: boolean;
  mismatch: FileCheck | undefined;
}): Verdict => {
  if (!isJudged || mismatch?.state === 'unreadable') {
    return 'unknown';
  }
  return mismatch === undefined ? 'clear' : { raise: reasonOf(mismatch) };
};

// Drift beats unknown, which beats clear; of two Drift verdicts the held one,
// from the record sorted first, stands.
const strongest = (held: Verdict | undefined, next: Verdict): Verdict => {
  if (held === undefined) {
    return next;
  }
  if (typeof held === 'object') {
    return held;
  }
  if (typeof next === 'object') {
    return next;
  }
  return held === 'unknown' || next === 'unknown' ? 'unknown' : 'clear';
};

// The mirrored files records this Hub can read, and whether any files record is
// unreadable: one the Collector listed as unreadable, or one whose mirrored
// shape this Hub does not know. Paths of an unreadable record are not known, so
// no path's Drift is cleared while one exists.
const readRecords = async (recordSet: RecordSetRow, mirrored: readonly MirroredRow[]) => {
  const records: ReadableRecord[] = [];
  let unreadable = (UnreadableRecordsSchema.safeParse(recordSet.unreadable).data ?? []).some(
    (ref) => ref.kind === 'files',
  );
  for (const row of mirrored) {
    const parsed = REPORTED_RECORD_SCHEMAS.files.safeParse(row.record);
    if (parsed.success) {
      records.push({
        // oxlint-disable-next-line no-await-in-loop -- digests are small and few.
        digest: await filesRecordDigest(parsed.data),
        name: row.name,
        paths: new Set(parsed.data.files.map((file) => file.path)),
      });
    } else {
      unreadable = true;
    }
  }
  return { records, unreadable };
};

// Raises and clears one System's Drift under the System's row lock, so it
// orders with its Reports (ADR-0005), at the time `clock` reads once the lock
// is held. Drift is one Condition per path. It is left as it is while the
// System's checks are absent or over budget, or its records are, since neither
// says what the files are now, for the paths of a record the checks did not
// judge as the Hub mirrors it, and while any files record is unreadable. Checks
// over budget judge no record, so only a path no record names is cleared.
const evaluateSystem = (sql: SQL, system: string, clock: () => number) =>
  sql.begin(async (tx) => {
    const [held]: { name: string }[] = await tx`
      SELECT name FROM systems WHERE name = ${system} FOR UPDATE
    `;
    const now = clock();
    const [checkSet]: CheckSetRow[] = await tx`
      SELECT over_budget_bytes, files, file_records FROM check_sets WHERE system = ${system}
    `;
    const [recordSet]: RecordSetRow[] = await tx`
      SELECT over_budget_bytes, unreadable FROM record_sets WHERE system = ${system}
    `;
    if (
      held === undefined ||
      checkSet === undefined ||
      recordSet === undefined ||
      recordSet.over_budget_bytes !== null
    ) {
      return;
    }
    const files = StoredFilesSchema.safeParse(checkSet.files);
    const fileRecords = StoredFileRecordsSchema.safeParse(checkSet.file_records);
    if (!files.success || !fileRecords.success) {
      return;
    }
    // Checks over budget list no files and judge no record.
    const judgedBy = checkSet.over_budget_bytes === null ? fileRecords.data : [];
    const mirrored: MirroredRow[] = await tx`
      SELECT name, record FROM mirrored_records WHERE system = ${system} AND kind = 'files'
    `;
    const open: { subject: string }[] = await tx`
      SELECT subject FROM conditions
      WHERE system = ${system} AND kind = ${DRIFT} AND cleared_at IS NULL
    `;
    const { records, unreadable } = await readRecords(recordSet, mirrored);
    const verdicts = verdictsOf({
      files: files.data,
      judged: new Map(judgedBy.map((entry) => [entry.record, entry.digest])),
      records,
    });
    // Drift for a path no files record names any more is cleared, which is how
    // a forgotten record clears its Drift.
    for (const { subject } of open) {
      if (!verdicts.has(subject)) {
        verdicts.set(subject, 'clear');
      }
    }

    const at = new Date(now);
    for (const [subject, verdict] of verdicts) {
      // An unreadable record may name any path, so nothing is cleared while one
      // exists; a path can still be raised.
      if (verdict === 'clear' && unreadable) {
        continue;
      }
      if (verdict === 'clear') {
        // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
        await clear(tx, { kind: DRIFT, now: at, subject, system });
      } else if (verdict !== 'unknown') {
        // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
        await raise(tx, { kind: DRIFT, now: at, reason: verdict.raise, subject, system });
      }
    }
  });

// Raises and clears every System's Drift, judging each at the time `clock`
// (epoch milliseconds) reads once it holds that System's lock. `serve` runs it
// every minute. A System that cannot be judged does not stop the rest; one
// error then names each such System and why.
export const evaluateDrift = async (sql: SQL, clock: () => number): Promise<void> => {
  const systems: { system: string }[] = await sql`SELECT system FROM check_sets ORDER BY system`;
  await evaluateEach(
    systems.map((row) => row.system),
    (system) => evaluateSystem(sql, system, clock),
  );
};
