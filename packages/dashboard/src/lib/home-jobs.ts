// How Home's Jobs card lists every recorded job: what state each is in, since
// when, and in what order.

import type { HomeJob, JobState } from '../server/home-types.ts';
import type { JobRun } from '../server/system-detail-types.ts';
import { whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';

// How many jobs the card lists before "+N more".
export const JOBS_SHOWN = 6;

// A recorded job's state on Home: failing when its latest run failed or Job
// failing is open, from when that run finished; overdue while Job overdue is
// open, from when it was raised; ok from when its latest run finished; due at
// its next scheduled time when it has never run.
export const homeJob = ({
  dueAt,
  failing,
  latestRun,
  name,
  overdueSince,
  system,
}: {
  dueAt: number | undefined;
  failing: boolean;
  latestRun: JobRun | undefined;
  name: string;
  overdueSince: number | undefined;
  system: string;
}): HomeJob => {
  const lastRunAt = latestRun?.finished;
  let state: JobState = latestRun === undefined ? 'due' : 'ok';
  let at = latestRun === undefined ? dueAt : lastRunAt;
  if (failing || (latestRun !== undefined && latestRun.exitStatus !== 0)) {
    state = 'failing';
    at = lastRunAt;
  } else if (overdueSince !== undefined) {
    state = 'overdue';
    at = overdueSince;
  }
  return { at, lastRunAt, name, state, system };
};

const RANK: Record<JobState, number> = { due: 2, failing: 0, ok: 2, overdue: 1 };

// Failing jobs first, then overdue, then by their latest run, the most recent
// first, with jobs that never ran last, then by System and name.
export const orderJobs = <T extends Pick<HomeJob, 'lastRunAt' | 'name' | 'state' | 'system'>>(
  jobs: readonly T[],
): T[] =>
  jobs.toSorted(
    (a, b) =>
      RANK[a.state] - RANK[b.state] ||
      (b.lastRunAt ?? Number.NEGATIVE_INFINITY) - (a.lastRunAt ?? Number.NEGATIVE_INFINITY) ||
      a.system.localeCompare(b.system) ||
      a.name.localeCompare(b.name),
  );

const WORDS: Record<JobState, string> = {
  due: 'due ',
  failing: 'failed ',
  ok: 'ok ',
  overdue: 'overdue since ',
};

// "failed 03:12", "overdue since Mon 04:00", "ok 01:00", or "due Sun 04:00";
// "not run yet" for a job whose next time is unknown.
export const jobWords = (job: HomeJob, now: number): Phrase => {
  if (job.at === undefined) {
    return [job.state === 'due' ? 'not run yet' : WORDS[job.state].trim()];
  }
  return [
    WORDS[job.state],
    job.state === 'due' ? { at: job.at, format: 'ahead', now } : whenAt(job.at, now),
  ];
};
