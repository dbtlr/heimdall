import { z } from 'zod';

import { RECORD_NAME, REPORTED_RUN_SCHEMA } from './records.ts';
import type { RunRecord } from './records.ts';
import { bytes } from './values.ts';

// The most bytes of JSON a Collector's runs section may take in a Report. With
// the record set's 8 MiB and a full batch of samples, a Report stays under the
// Hub's 12 MiB cap. Runs over it travel as a marker.
export const MAX_RUNS_SECTION_BYTES = 2 * 1024 * 1024;

const jobName = z.string().regex(RECORD_NAME);

// A run as the Collector holds it, which the Hub reads with its own schema.
const sentRun = z.record(z.string(), z.unknown());

// One job's latest run and its latest successful run, which may be the same
// run, or null when the job has not succeeded in the runs the Collector keeps.
const SentJobRunsSchema = z.object({
  job: jobName,
  latestRun: sentRun,
  latestSuccess: sentRun.nullable(),
});

// A Report's runs section: the latest run and latest success of each job that
// has reported a run, and the jobs whose latest runs the Collector could not
// read. A job with no runs is in neither list. A Collector sends it when those
// runs change, when it starts, and hourly; the Hub replaces the System's latest
// runs with it. Runs over budget are sent as their size alone.
export const RunsSectionSchema = z.union([
  z.object({ jobs: z.array(SentJobRunsSchema), unreadable: z.array(jobName) }),
  z.object({ overBudget: z.object({ bytes }) }),
]);

export type RunsSection = z.infer<typeof RunsSectionSchema>;
export type SentJobRuns = z.infer<typeof SentJobRunsSchema>;

// One job's latest runs as the Hub mirrors them.
export type JobRuns = { job: string; latestRun: RunRecord; latestSuccess: RunRecord | null };

// A System's latest runs as the Hub mirrors them, or the size of runs it could
// not be sent.
export type MirroredRuns =
  | { jobs: JobRuns[]; unreadable: string[] }
  | { overBudget: { bytes: number } };

// One job's latest runs, or undefined when this Hub cannot read them.
const mirrorJob = ({ job, latestRun, latestSuccess }: SentJobRuns): JobRuns | undefined => {
  const run = REPORTED_RUN_SCHEMA.safeParse(latestRun);
  const success = latestSuccess === null ? undefined : REPORTED_RUN_SCHEMA.safeParse(latestSuccess);
  if (!run.success || success?.success === false) {
    return undefined;
  }
  return { job, latestRun: run.data, latestSuccess: success?.data ?? null };
};

// The latest runs a Hub mirrors from a runs section. A job whose runs this Hub
// cannot read still ran, so it counts as unreadable rather than missing. A job
// sent twice keeps the last, and one that is mirrored is not also unreadable.
export const mirrorRuns = (section: RunsSection): MirroredRuns => {
  if ('overBudget' in section) {
    return { overBudget: section.overBudget };
  }
  const jobs = new Map<string, JobRuns>();
  const unreadable = new Set(section.unreadable);
  for (const entry of section.jobs) {
    const mirrored = mirrorJob(entry);
    if (mirrored === undefined) {
      jobs.delete(entry.job);
      unreadable.add(entry.job);
    } else {
      jobs.set(entry.job, mirrored);
    }
  }
  return {
    jobs: [...jobs.values()],
    unreadable: [...unreadable].filter((job) => !jobs.has(job)),
  };
};
