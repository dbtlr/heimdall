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
  // The last runs with the scheduled times no run answered, oldest first;
  // undefined when the Hub holds no stored run of any job the System records,
  // as for a Collector that sends no run history, so its runs are unknown
  // rather than missed.
  strip: StripCell[] | undefined;
  // The System's zone, which the schedule's times are in; null when unknown.
  timeZone: string | null;
  // For an overdue job, the latest scheduled time its grace has passed since.
  wasDueAt: number | undefined;
};

export type Jobs = { jobs: JobsRow[]; now: number };
