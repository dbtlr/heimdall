import { z } from 'zod';

import { FUTURE_SAMPLE_TOLERANCE_MS } from './conditions.ts';
import { RECORD_NAME, REPORTED_RUN_SCHEMA } from './records.ts';

// The most job runs one Report carries. A run comes to at most 782 bytes of
// JSON, with a 128-character job name, a 255-character output file of
// characters JSON escapes to two bytes, and the largest exit status and size,
// so a full section is at most about 783 KB; the rest of a longer backlog
// rides the next Reports.
export const MAX_JOB_RUNS_PER_REPORT = 1000;

// One run of a job as the job recorded it with `heimdall-collector record run`,
// with the job it belongs to. The job and `started` key the run. A field only a
// newer Collector knows is dropped rather than rejecting the Report (ADR-0004).
// A run recorded again with the same start is sent again whole, and the Hub
// replaces what it holds for it.
const SentJobRunSchema = REPORTED_RUN_SCHEMA.safeExtend({
  job: z.string().regex(RECORD_NAME),
});

// A Report's job runs section: the runs the Collector holds that the Hub has
// not yet taken (ADR-0023). A Collector sends the oldest first, but the Hub
// requires no order. A Collector sends it while it holds any, and settles each
// run once a Report carrying it is delivered. It feeds the Hub's run history;
// job Conditions are still judged from the latest runs in the runs section.
export const JobRunsSectionSchema = z.object({
  runs: z
    .array(SentJobRunSchema)
    .max(MAX_JOB_RUNS_PER_REPORT)
    .refine(
      (runs) =>
        new Set(runs.map(({ job, started }) => JSON.stringify([job, started]))).size ===
        runs.length,
      { message: 'duplicate job run' },
    ),
});

export type JobRunsSection = z.infer<typeof JobRunsSectionSchema>;
export type SentJobRun = z.infer<typeof SentJobRunSchema>;

// A Report's job runs section as the Hub reads it: only its structure is
// checked, so a run it cannot take costs that run and never the Report. The Hub
// checks each entry with `takeJobRuns` (ADR-0004).
export const ReportedJobRunsSectionSchema = z.object({
  runs: z.array(z.unknown()).max(MAX_JOB_RUNS_PER_REPORT),
});

export type ReportedJobRunsSection = z.infer<typeof ReportedJobRunsSectionSchema>;

// A run the Hub dropped, with what is known of it and why.
export type DroppedJobRun = { job?: string; reason: string; started?: string };

const textOf = (value: unknown, key: string): string | undefined => {
  const field = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  return typeof field === 'string' ? field : undefined;
};

const reasonOf = (error: z.ZodError) =>
  error.issues.map(({ message, path }) => `${path.join('.') || 'run'}: ${message}`).join('; ');

// Takes the entries of a Report's job runs section one at a time, in order, for
// a Report that reached the Hub at `arrival` (epoch milliseconds). An entry is
// dropped when it is not a valid run, when it repeats the key (job and
// `started`) of an earlier entry that passed, or when it starts or finishes more
// than the samples' tolerance after `arrival`. Keys count only among passing entries, so
// an invalid entry never shadows a later valid one.
export const takeJobRuns = (
  entries: readonly unknown[],
  arrival: number,
): { dropped: DroppedJobRun[]; taken: SentJobRun[] } => {
  const taken: SentJobRun[] = [];
  const dropped: DroppedJobRun[] = [];
  const keys = new Set<string>();
  for (const entry of entries) {
    const parsed = SentJobRunSchema.safeParse(entry);
    const known = { job: textOf(entry, 'job'), started: textOf(entry, 'started') };
    const drop = (reason: string) =>
      dropped.push({
        reason,
        ...(known.job === undefined ? {} : { job: known.job }),
        ...(known.started === undefined ? {} : { started: known.started }),
      });
    if (!parsed.success) {
      drop(reasonOf(parsed.error));
    } else if (Date.parse(parsed.data.started) > arrival + FUTURE_SAMPLE_TOLERANCE_MS) {
      drop("it starts more than 5 minutes after the Hub's clock");
    } else if (Date.parse(parsed.data.finished) > arrival + FUTURE_SAMPLE_TOLERANCE_MS) {
      drop("it finishes more than 5 minutes after the Hub's clock");
    } else {
      const key = JSON.stringify([parsed.data.job, parsed.data.started]);
      if (keys.has(key)) {
        drop('it repeats the job and start of an earlier run');
      } else {
        keys.add(key);
        taken.push(parsed.data);
      }
    }
  }
  return { dropped, taken };
};
