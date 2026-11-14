// What the Jobs page says about each job: the strip of its last runs, with the
// runs it missed, and when its latest run started and how long it took.

import { scheduledTimesBetween } from '@heimdall/schema';

import type { HomeJob } from '../server/home-types.ts';
import type { JobsRow } from '../server/jobs-types.ts';
import type { JobRun, ScheduleEntry } from '../server/system-detail-types.ts';
import { whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';
import { formatSpan } from './time.ts';

// How many cells a job's strip shows.
export const STRIP_RUNS = 14;

// How long the Hub waits, in awake time, for a run after a scheduled time
// before it raises Job overdue, when the job's record sets no grace period.
export const DEFAULT_GRACE_MINUTES = 60;

const DAY_MS = 86_400_000;

// The longest span a strip looks back over for missed runs: a little over
// four years, as far as the schedule functions search.
const MAX_SPAN_MS = 1500 * DAY_MS;

// One cell of a strip: a run that succeeded or failed, at its start, or a
// scheduled time that passed with no run.
export type StripCell = { at: number; kind: 'failed' | 'missed' | 'ok' };

type MissedInput = {
  graceMs: number;
  now: number;
  runs: readonly JobRun[];
  schedule: readonly ScheduleEntry[];
  timeZone: string;
};

// The scheduled times from `from` to `now` that no run answered. A run
// answers a scheduled time when it started at or after it and before the next
// one, or before `graceMs` has passed when that is later. So a run that
// launchd starts when a System wakes counts for the time the System slept
// through, as the Hub, which waits for awake time and not wall-clock time,
// raises no Job overdue for it. A time is not missed until `graceMs` has
// passed.
const missedBetween = ({
  from,
  graceMs,
  now,
  runs,
  schedule,
  timeZone,
}: MissedInput & { from: number }): number[] => {
  const times = scheduledTimesBetween({ from, schedule, timeZone, to: now });
  return times.filter((time, index) => {
    if (time + graceMs > now) {
      return false;
    }
    const until = Math.max(time + graceMs, times[index + 1] ?? Number.POSITIVE_INFINITY);
    return !runs.some(({ started }) => started >= time && started < until);
  });
};

// The scheduled times, oldest first, that no run answered, back to
// `notBefore`. Only the newest `limit` cells show, so it looks back a day,
// then twice as far each time, until the span holds `limit` cells: a schedule
// that fires every minute lists about a day of times, not every time since
// `notBefore`.
const missedTimes = ({
  limit,
  notBefore,
  ...input
}: MissedInput & { limit: number; notBefore: number }): number[] => {
  const floor = Math.max(notBefore, input.now - MAX_SPAN_MS);
  for (let span = DAY_MS; ; span *= 2) {
    const from = Math.max(floor, input.now - span);
    const missed = missedBetween({ ...input, from });
    const ran = input.runs.filter(({ started }) => started >= from).length;
    if (from === floor || missed.length + ran >= limit) {
      return missed;
    }
  }
};

// The newest `limit` cells of a job, oldest first: its runs and the scheduled
// times no run answered, back to `notBefore`, the earliest time the runs given
// can speak for. Without a zone no schedule can be read, so only the runs
// show. `runs` holds the job's newest runs.
export const jobStrip = ({
  graceMs,
  limit = STRIP_RUNS,
  notBefore,
  now,
  runs,
  schedule,
  timeZone,
}: {
  graceMs: number;
  limit?: number;
  notBefore: number;
  now: number;
  runs: readonly JobRun[];
  schedule: readonly ScheduleEntry[];
  timeZone: string | null;
}): StripCell[] => {
  const ran = runs.map(({ exitStatus, started }): StripCell => ({
    at: started,
    kind: exitStatus === 0 ? 'ok' : 'failed',
  }));
  let missed: number[] = [];
  if (timeZone !== null) {
    try {
      missed = missedTimes({ graceMs, limit, notBefore, now, runs, schedule, timeZone });
    } catch {
      // A zone this runtime does not know.
    }
  }
  return [...ran, ...missed.map((at): StripCell => ({ at, kind: 'missed' }))]
    .toSorted((a, b) => a.at - b.at)
    .slice(-limit);
};

// What follows a job's schedule: its System's zone when the viewer's differs,
// since the schedule is in the System's local time and every other time on the
// page is in the viewer's.
export const scheduleZone = (systemZone: string | null, viewerZone: string): string =>
  systemZone === null || systemZone === viewerZone ? '' : ` ${systemZone}`;

// The sentence under the page's title: how many jobs on how many Systems, and
// how many are failing or overdue.
export const jobsSummary = (jobs: readonly Pick<HomeJob, 'state' | 'system'>[]): string => {
  const systems = new Set(jobs.map(({ system }) => system)).size;
  const failing = jobs.filter(({ state }) => state === 'failing').length;
  const overdue = jobs.filter(({ state }) => state === 'overdue').length;
  const open = [
    ...(failing > 0 ? [`${String(failing)} failing`] : []),
    ...(overdue > 0 ? [`${String(overdue)} overdue`] : []),
  ];
  const count = `${String(jobs.length)} ${jobs.length === 1 ? 'job' : 'jobs'} on ${String(systems)} ${systems === 1 ? 'System' : 'Systems'}`;
  return open.length === 0 ? `${count}.` : `${count}. ${open.join(', ')}.`;
};

type Latest = Pick<JobsRow, 'latestRun'>;
type Due = Pick<JobsRow, 'graceMinutes' | 'nextDue' | 'state' | 'wasDueAt'>;

// When the latest run started, which reads against the schedule, how long it
// took, and its exit status: "03:00 · 4 min · exit 1", the day too when it is
// not today; undefined for a job that never ran.
export const latestRunWords = ({ latestRun }: Latest, now: number): Phrase | undefined =>
  latestRun === undefined
    ? undefined
    : [
        whenAt(latestRun.started, now),
        ` · ${formatSpan(latestRun.finished - latestRun.started)} · exit ${String(latestRun.exitStatus)}`,
      ];

// When the job is next due; for an overdue job when it was due and how long
// the Hub waits for a run.
export const dueWords = (job: Due, now: number): Phrase => {
  if (job.state === 'overdue' && job.wasDueAt !== undefined) {
    return [
      'was due ',
      whenAt(job.wasDueAt, now),
      ` · grace ${formatSpan(job.graceMinutes * 60_000)}`,
    ];
  }
  return job.nextDue === undefined ? ['unknown'] : [{ at: job.nextDue, format: 'ahead', now }];
};
