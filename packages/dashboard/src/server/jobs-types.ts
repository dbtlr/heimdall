// What the Jobs page reads: every job a paired System's provisioner recorded,
// with its state, its latest run, and its last runs. Times are epoch
// milliseconds.

import type { StripCell } from '../lib/jobs.ts';
import type { HomeJob } from './home-types.ts';
import type { JobRun, ScheduleEntry } from './system-detail-types.ts';

// A job as Home states it (`state`, and `at` when that began), with what the
// page adds.
export type JobsRow = HomeJob & {
  // The awake time the Hub waits after a scheduled time for a run before it
  // raises Job overdue.
  graceMinutes: number;
  latestRun: JobRun | undefined;
  // The job's next scheduled time, undefined when its System's time zone is
  // unknown or the schedule names no time.
  nextDue: number | undefined;
  schedule: ScheduleEntry[];
  scheduler: string;
  // The last runs with the scheduled times they missed, oldest first;
  // undefined when the Hub holds no stored run of the job, as for a Collector
  // that sends none, so its history is unknown rather than missed.
  strip: StripCell[] | undefined;
  // For an overdue job, the latest scheduled time up to now.
  wasDueAt: number | undefined;
};

export type Jobs = { jobs: JobsRow[]; now: number };
