import { FILE_CHECK_STATES, REPORTED_RECORD_SCHEMAS } from '@heimdall/schema';
import type { SQL } from 'bun';
import { z } from 'zod';

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

type FileCheck = z.infer<typeof StoredFilesSchema>[number];

const UnreadableRecordsSchema = z.array(z.object({ kind: z.string(), name: z.string() }));

type CheckSetRow = { files: unknown; over_budget_bytes: string | null };
type RecordSetRow = { over_budget_bytes: string | null; unreadable: unknown };

// The names of the files records the Hub cannot read: those the Collector
// listed as unreadable, and those whose mirrored shape this Hub does not know.
const unreadableFilesRecords = (
  recordSet: RecordSetRow,
  mirrored: { name: string; record: unknown }[],
) =>
  new Set([
    ...(UnreadableRecordsSchema.safeParse(recordSet.unreadable).data ?? [])
      .filter((ref) => ref.kind === 'files')
      .map((ref) => ref.name),
    ...mirrored
      .filter((row) => !REPORTED_RECORD_SCHEMAS.files.safeParse(row.record).success)
      .map((row) => row.name),
  ]);

// The paths each readable files record names.
const pathsByRecord = (mirrored: { name: string; record: unknown }[]) =>
  new Map(
    mirrored.flatMap((row) => {
      const parsed = REPORTED_RECORD_SCHEMAS.files.safeParse(row.record);
      return parsed.success ? [[row.name, new Set(parsed.data.files.map((f) => f.path))]] : [];
    }),
  );

const reasonOf = ({ record, state }: FileCheck) =>
  state === 'missing'
    ? `Missing: the file recorded in ${record} does not exist.`
    : `Changed: its content no longer matches the hash recorded in ${record}.`;

// What each file the checks list decides. A file a record no longer names does
// not count, since its provisioner forgot it or stopped recording it; a file
// whose record the Hub cannot read, or the Collector could not read, is
// unknown, and so is one the Collector could not read, which says nothing of
// its content. Drift wins over unknown, so a path is raised while any record
// shows it changed or missing.
const verdictsOf = ({
  files,
  paths,
  unreadable,
}: {
  files: FileCheck[];
  paths: Map<string, Set<string>>;
  unreadable: Set<string>;
}) => {
  const verdicts = new Map<string, Verdict>();
  const ordered = files.toSorted((a, b) => a.record.localeCompare(b.record));
  for (const file of ordered) {
    let verdict: Verdict | undefined;
    if (unreadable.has(file.record)) {
      verdict = 'unknown';
    } else if (paths.get(file.record)?.has(file.path) === true) {
      verdict = file.state === 'unreadable' ? 'unknown' : { raise: reasonOf(file) };
    }
    const held = verdicts.get(file.path);
    if (
      verdict !== undefined &&
      (held === undefined || (held === 'unknown' && verdict !== 'unknown'))
    ) {
      verdicts.set(file.path, verdict);
    }
  }
  return verdicts;
};

// Raises and clears one System's Drift under the System's row lock, so it
// orders with its Reports (ADR-0005), at the time `clock` reads once the lock
// is held. Drift is one Condition per path. It is left as it is while the
// System's checks or records are absent or over budget, since neither says what
// the files are now.
const evaluateSystem = (sql: SQL, system: string, clock: () => number) =>
  sql.begin(async (tx) => {
    const [held]: { name: string }[] = await tx`
      SELECT name FROM systems WHERE name = ${system} FOR UPDATE
    `;
    const now = clock();
    const [checkSet]: CheckSetRow[] = await tx`
      SELECT over_budget_bytes, files FROM check_sets WHERE system = ${system}
    `;
    const [recordSet]: RecordSetRow[] = await tx`
      SELECT over_budget_bytes, unreadable FROM record_sets WHERE system = ${system}
    `;
    if (
      held === undefined ||
      checkSet === undefined ||
      checkSet.over_budget_bytes !== null ||
      recordSet === undefined ||
      recordSet.over_budget_bytes !== null
    ) {
      return;
    }
    const files = StoredFilesSchema.safeParse(checkSet.files);
    if (!files.success) {
      return;
    }
    const mirrored: { name: string; record: unknown }[] = await tx`
      SELECT name, record FROM mirrored_records WHERE system = ${system} AND kind = 'files'
    `;
    const open: { subject: string }[] = await tx`
      SELECT subject FROM conditions
      WHERE system = ${system} AND kind = ${DRIFT} AND cleared_at IS NULL
    `;
    const verdicts = verdictsOf({
      files: files.data,
      paths: pathsByRecord(mirrored),
      unreadable: unreadableFilesRecords(recordSet, mirrored),
    });
    // A path nothing says is not drifted is cleared, which also clears the
    // Drift of a record forgotten since the checks were sent.
    for (const { subject } of open) {
      if (!verdicts.has(subject)) {
        verdicts.set(subject, 'clear');
      }
    }

    const at = new Date(now);
    for (const [subject, verdict] of verdicts) {
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
