import { REPORTED_RECORD_SCHEMAS, REPORTED_RUN_SCHEMA, SAMPLE_INTERVAL_MS } from '@heimdall/schema';
import type { JobRecord, RunRecord } from '@heimdall/schema';
import type { SQL } from 'bun';
import { z } from 'zod';

import { latestScheduledTime } from './schedule.ts';
import type { ConditionKind } from './store.ts';

// How long the Hub waits after a scheduled time, in its System's awake time,
// for a successful run before it raises job overdue, unless the job's record
// sets its own grace period.
export const DEFAULT_GRACE_MINUTES = 60;

// How far back the Hub looks for a System's awake time. A grace period the
// System was not awake for within it has not run out, so job overdue is
// neither raised nor cleared.
const AWAKE_HORIZON_MS = 90 * 24 * 60 * 60_000;

// The most samples a Vitals rollup bucket (ADR-0008) counts as awake time:
// its 5 minutes.
const SAMPLES_PER_BUCKET = (5 * 60_000) / SAMPLE_INTERVAL_MS;

const JOB_KINDS: readonly ConditionKind[] = ['job_failing', 'job_overdue'];

// What the Hub should do with one job Condition: raise it with a reason (or
// update the reason of the open one), clear it, or leave it as it is because
// what decides it is unknown.
type Verdict = { raise: string } | 'clear' | 'unknown';

// A job's latest run and latest success, null when it has not reported a run,
// or 'unknown' when the Hub cannot tell.
type LatestRuns = { latestRun: RunRecord; latestSuccess: RunRecord | null } | null | 'unknown';

// The start of the earliest rollup bucket from which the System was awake for
// at least `graceMs` up to now, or undefined when it has not been.
type AwakeCutoff = (graceMs: number) => number | undefined;

const failingVerdict = (runs: LatestRuns): Verdict => {
  if (runs === 'unknown') {
    return 'unknown';
  }
  if (runs === null || runs.latestRun.exitStatus === 0) {
    return 'clear';
  }
  const { exitStatus, started } = runs.latestRun;
  return { raise: `The run started ${started} exited with status ${String(exitStatus)}.` };
};

// The wall-clock minute `ms` names in `timeZone`, such as `2026-10-06 03:30`.
const wallClock = (ms: number, timeZone: string) =>
  Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toPlainDateTime()
    .toString({ smallestUnit: 'minute' })
    .replace('T', ' ');

// Job overdue (ADR-0011): one of the job's scheduled times, no earlier than
// when the Hub first mirrored it, passed and was followed by its grace period
// of awake time with no successful run started since.
const overdueVerdict = ({
  awakeCutoff,
  mirroredSince,
  record,
  runs,
  timeZone,
}: {
  awakeCutoff: AwakeCutoff;
  mirroredSince: number;
  record: JobRecord;
  runs: LatestRuns;
  timeZone: string | null;
}): Verdict => {
  if (runs === 'unknown' || timeZone === null) {
    return 'unknown';
  }
  const cutoff = awakeCutoff((record.graceMinutes ?? DEFAULT_GRACE_MINUTES) * 60_000);
  if (cutoff === undefined) {
    return 'unknown';
  }
  let scheduled: number | undefined;
  try {
    scheduled = latestScheduledTime({
      atOrBefore: cutoff,
      notBefore: mirroredSince,
      schedule: record.schedule,
      timeZone,
    });
  } catch (error) {
    // A zone this Hub's time zone database does not know.
    if (error instanceof RangeError) {
      return 'unknown';
    }
    throw error;
  }
  const success = runs?.latestSuccess;
  if (scheduled === undefined || (success && Date.parse(success.started) >= scheduled)) {
    return 'clear';
  }
  return {
    raise: `Scheduled for ${wallClock(scheduled, timeZone)} ${timeZone}; no successful run since.`,
  };
};

// A mirrored job, with when the Hub first mirrored it.
type JobRow = { first_mirrored_at: Date | null; name: string; record: unknown };
type RunRow = { job: string; latest_run: unknown; latest_success: unknown };
type SetRow = { over_budget_bytes: string | null; unreadable: unknown };
type BucketRow = { awake_samples: string; bucket: Date };

// The unreadable rows a record set or a runs section lists, as the Hub stored
// them: record references, and job names.
const UnreadableRecordsSchema = z.array(z.object({ kind: z.string(), name: z.string() }));
const UnreadableJobsSchema = z.array(z.string());

// The names of the jobs whose records a record set lists as unreadable.
const unreadableJobRecords = (unreadable: unknown) =>
  new Set(
    (UnreadableRecordsSchema.safeParse(unreadable).data ?? [])
      .filter((ref) => ref.kind === 'job')
      .map((ref) => ref.name),
  );

// Each job's latest runs as the Hub holds them for one System.
const latestRunsOf = async (tx: SQL, system: string): Promise<(job: string) => LatestRuns> => {
  const [runSet]: SetRow[] = await tx`
    SELECT over_budget_bytes, unreadable FROM run_sets WHERE system = ${system}
  `;
  // A Collector older than runs, and runs over budget, leave every job unknown.
  if (runSet === undefined || runSet.over_budget_bytes !== null) {
    return () => 'unknown';
  }
  const unreadable = new Set(UnreadableJobsSchema.safeParse(runSet.unreadable).data);
  const rows: RunRow[] = await tx`
    SELECT job, latest_run, latest_success FROM mirrored_runs WHERE system = ${system}
  `;
  const runs = new Map<string, LatestRuns>();
  for (const row of rows) {
    const latestRun = REPORTED_RUN_SCHEMA.safeParse(row.latest_run);
    const latestSuccess =
      row.latest_success === null ? null : REPORTED_RUN_SCHEMA.safeParse(row.latest_success);
    runs.set(
      row.job,
      latestRun.success && latestSuccess?.success !== false
        ? { latestRun: latestRun.data, latestSuccess: latestSuccess?.data ?? null }
        : 'unknown',
    );
  }
  return (job) => (unreadable.has(job) ? 'unknown' : (runs.get(job) ?? null));
};

// The System's awake time, from the samples its Collector took every
// SAMPLE_INTERVAL_MS, counted per 5-minute bucket up to `now`. A bucket after
// `now` comes from a clock running ahead and is not counted.
const awakeCutoffOf = async (tx: SQL, system: string, now: number): Promise<AwakeCutoff> => {
  const buckets: BucketRow[] = await tx`
    SELECT bucket, sum(LEAST(samples, ${SAMPLES_PER_BUCKET})) OVER (ORDER BY bucket DESC)
             AS awake_samples
    FROM vitals_rollups
    WHERE system = ${system} AND bucket <= ${new Date(now)}
      AND bucket > ${new Date(now - AWAKE_HORIZON_MS)}
    ORDER BY bucket DESC
  `;
  return (graceMs) =>
    buckets.find((b) => Number(b.awake_samples) * SAMPLE_INTERVAL_MS >= graceMs)?.bucket.getTime();
};

const raise = (
  tx: SQL,
  {
    kind,
    now,
    reason,
    subject,
    system,
  }: Record<'kind' | 'reason' | 'subject' | 'system', string> & { now: Date },
) => tx`
  INSERT INTO conditions (system, kind, subject, raised_at, raised_reason, latest_at, latest_reason)
  VALUES (${system}, ${kind}, ${subject}, ${now}, ${reason}, ${now}, ${reason})
  ON CONFLICT (system, kind, subject) WHERE cleared_at IS NULL DO UPDATE SET
    latest_at = excluded.latest_at,
    latest_reason = excluded.latest_reason
  WHERE conditions.latest_reason <> excluded.latest_reason
`;

const clear = (
  tx: SQL,
  { kind, now, subject, system }: Record<'kind' | 'subject' | 'system', string> & { now: Date },
) => tx`
  UPDATE conditions SET cleared_at = GREATEST(raised_at, ${now})
  WHERE system = ${system} AND kind = ${kind} AND subject = ${subject} AND cleared_at IS NULL
`;

// Raises and clears one System's job Conditions under the System's row lock,
// so they order with its Reports (ADR-0005), at the time `clock` reads once
// the lock is held.
const evaluateSystem = (sql: SQL, system: string, clock: () => number) =>
  sql.begin(async (tx) => {
    const [held]: { time_zone: string | null }[] = await tx`
      SELECT time_zone FROM systems WHERE name = ${system} FOR UPDATE
    `;
    const now = clock();
    const [recordSet]: SetRow[] = await tx`
      SELECT over_budget_bytes, unreadable FROM record_sets WHERE system = ${system}
    `;
    // Records over budget leave every job, and so every job Condition, unknown.
    if (held === undefined || recordSet === undefined || recordSet.over_budget_bytes !== null) {
      return;
    }
    const jobs: JobRow[] = await tx`
      SELECT m.name, m.record, f.first_mirrored_at
      FROM mirrored_records m
      LEFT JOIN records_first_mirrored f USING (system, kind, name)
      WHERE m.system = ${system} AND m.kind = 'job'
    `;
    const open: { kind: ConditionKind; subject: string }[] = await tx`
      SELECT kind, subject FROM conditions
      WHERE system = ${system} AND kind IN ${tx(JOB_KINDS)} AND cleared_at IS NULL
    `;
    const unreadable = unreadableJobRecords(recordSet.unreadable);
    const runsOf = await latestRunsOf(tx, system);
    const awakeCutoff = await awakeCutoffOf(tx, system, now);

    const verdicts = new Map<string, Record<'job_failing' | 'job_overdue', Verdict>>();
    for (const row of jobs) {
      const record = REPORTED_RECORD_SCHEMAS.job.safeParse(row.record);
      const runs = runsOf(row.name);
      verdicts.set(
        row.name,
        record.success
          ? {
              job_failing: failingVerdict(runs),
              job_overdue: overdueVerdict({
                awakeCutoff,
                // A record with no first time, which only a damaged table
                // holds, counts from now.
                mirroredSince: row.first_mirrored_at?.getTime() ?? now,
                record: record.data,
                runs,
                timeZone: held.time_zone,
              }),
            }
          : { job_failing: 'unknown', job_overdue: 'unknown' },
      );
    }
    // A job no longer recorded clears its Conditions; one whose record the
    // Collector or the Hub cannot read is unknown.
    for (const { subject } of open) {
      if (!verdicts.has(subject)) {
        const verdict = unreadable.has(subject) ? 'unknown' : 'clear';
        verdicts.set(subject, { job_failing: verdict, job_overdue: verdict });
      }
    }

    const at = new Date(now);
    for (const [subject, byKind] of verdicts) {
      for (const [kind, verdict] of Object.entries(byKind)) {
        if (verdict === 'clear') {
          // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
          await clear(tx, { kind, now: at, subject, system });
        } else if (verdict !== 'unknown') {
          // oxlint-disable-next-line no-await-in-loop -- one transaction runs one statement at a time.
          await raise(tx, { kind, now: at, reason: verdict.raise, subject, system });
        }
      }
    }
  });

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Raises and clears every System's job failing and job overdue Conditions,
// judging each at the time `clock` (epoch milliseconds) reads once it holds
// that System's lock. `serve` runs it every minute. A System that cannot be
// judged does not stop the rest; one error then names each such System and why.
export const evaluateJobConditions = async (sql: SQL, clock: () => number): Promise<void> => {
  const systems: { system: string }[] = await sql`SELECT system FROM record_sets ORDER BY system`;
  const failures: { error: unknown; system: string }[] = [];
  for (const { system } of systems) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- one System at a time keeps the load even.
      await evaluateSystem(sql, system, clock);
    } catch (error) {
      failures.push({ error, system });
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((f) => f.error),
      failures.map((f) => `${f.system}: ${describeError(f.error)}`).join('; '),
    );
  }
};
