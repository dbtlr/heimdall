import { z } from 'zod';

import { RECORD_NAME, REPORTED_RUN_SCHEMA } from './records.ts';

// The most job runs one Report carries. A run comes to at most about 530 bytes
// of JSON, with a 128-character job name and a 255-character output file, so a
// full section is at most about 530 KB; the rest of a longer backlog rides the
// next Reports.
export const MAX_JOB_RUNS_PER_REPORT = 1000;

// How long the Hub keeps a job run, counted from its `started` (ADR-0023).
export const JOB_RUN_RETENTION_DAYS = 90;

// One run of a job as the job recorded it with `heimdall-collector record run`,
// with the job it belongs to. The job and `started` key the run. A field only a
// newer Collector knows is dropped rather than rejecting the Report (ADR-0004).
// A run recorded again with the same start is sent again whole, and the Hub
// replaces what it holds for it.
const SentJobRunSchema = REPORTED_RUN_SCHEMA.safeExtend({
  job: z.string().regex(RECORD_NAME),
});

// A Report's job runs section: the runs the Collector holds that the Hub has
// not yet taken, oldest first (ADR-0023). A Collector sends it while it holds
// any, and settles each run once a Report carrying it is delivered. It feeds
// the Hub's run history; job Conditions are still judged from the latest runs
// in the runs section.
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
