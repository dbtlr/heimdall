// Helpers that read rows the Hub writes: its stored records, checks, runs, and
// Conditions.

import { filesRecordDigest } from '@heimdall/schema';
import type { ConditionKind } from '@heimdall/schema';

import type { JobRun, ScheduleEntry, ServiceCheck } from './system-detail-types.ts';

export const field = (input: unknown, key: string): unknown =>
  typeof input === 'object' && input !== null ? Reflect.get(input, key) : undefined;

export type RecordRow = { kind: string; name: string; record: Record<string, unknown> };

export type ChecksRow = {
  file_records: { digest: string; record: string }[] | null;
  files: { path: string; record: string; since: number; state: string }[] | null;
  services: (ServiceCheck & { service: string })[] | null;
};

export type RunRow = {
  job: string;
  latest_run: { exitStatus: number; finished: string; started: string };
};

export const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const NUMBER_FIELDS = ['day', 'hour', 'minute', 'month', 'weekday'] as const;

// A job record's schedule: its calendar entries, each with the numeric fields
// it names.
export const scheduleOf = (schedule: unknown): ScheduleEntry[] =>
  Array.isArray(schedule)
    ? schedule.map((entry: unknown) => {
        const found: ScheduleEntry = {};
        for (const key of NUMBER_FIELDS) {
          const value = field(entry, key);
          if (typeof value === 'number') {
            found[key] = value;
          }
        }
        return found;
      })
    : [];

// A files record's files, each with its path and hash.
export const filesOf = (files: unknown): { path: string; sha256: string }[] =>
  Array.isArray(files)
    ? files.flatMap((entry: unknown) => {
        const path = field(entry, 'path');
        const sha256 = field(entry, 'sha256');
        return typeof path === 'string' && typeof sha256 === 'string' ? [{ path, sha256 }] : [];
      })
    : [];

export const toRun = (run: RunRow['latest_run']): JobRun => ({
  exitStatus: run.exitStatus,
  finished: Date.parse(run.finished),
  started: Date.parse(run.started),
});

// The checks of a Service: its supervisor's first, then the others by name.
export const byCheck = (a: ServiceCheck, b: ServiceCheck) =>
  Number(b.check === 'supervisor') - Number(a.check === 'supervisor') ||
  a.check.localeCompare(b.check);

// The names of the files records the latest checks judged. As in the Hub's
// Drift rule, the checks speak for a files record only when their files part is
// there and names it with the digest of the record the Hub mirrors.
export const judgedFilesRecords = async (
  checks: Pick<ChecksRow, 'file_records' | 'files'> | undefined,
  records: readonly RecordRow[],
): Promise<Set<string>> => {
  if (checks?.files == null) {
    return new Set();
  }
  const digests = new Map((checks.file_records ?? []).map((row) => [row.record, row.digest]));
  const names = await Promise.all(
    records
      .filter((row) => row.kind === 'files')
      .map(async ({ name, record }) =>
        digests.get(name) === (await filesRecordDigest({ files: filesOf(record.files) }))
          ? [name]
          : [],
      ),
  );
  return new Set(names.flat());
};

const CONDITION_KINDS: Record<ConditionKind, true> = {
  clock_skew: true,
  drift: true,
  high_cpu: true,
  high_memory: true,
  hot_process: true,
  job_failing: true,
  job_overdue: true,
  low_disk: true,
  pending_update: true,
  reboot_required: true,
  reports_rejected: true,
  service_down: true,
  system_stale: true,
};

const isConditionKind = (kind: string): kind is ConditionKind => kind in CONDITION_KINDS;

export const conditionKind = (kind: string): ConditionKind => {
  if (!isConditionKind(kind)) {
    throw new Error(
      `The Hub holds a Condition of kind ${kind}, which the dashboard does not know.`,
    );
  }
  return kind;
};

// Groups `rows` by their `system`.
export const bySystem = <Row extends { system: string }>(rows: readonly Row[]) => {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    grouped.set(row.system, [...(grouped.get(row.system) ?? []), row]);
  }
  return grouped;
};
