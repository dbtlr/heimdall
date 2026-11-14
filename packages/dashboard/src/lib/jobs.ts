// What the Jobs page says about each job: the strip of its last runs, with the
// runs it missed, when its schedule fires, and how long a run took.

import { latestScheduledTime } from '@heimdall/schema';

import type { HomeJob } from '../server/home-types.ts';
import type { JobsRow } from '../server/jobs-types.ts';
import type { JobRun, ScheduleEntry } from '../server/system-detail-types.ts';
import { whenAt } from './phrase.ts';
import type { Phrase } from './phrase.ts';

// How many cells a job's strip shows.
export const STRIP_RUNS = 14;

// How long the Hub waits, in awake time, for a run after a scheduled time
// before it raises Job overdue, when the job's record sets no grace period.
export const DEFAULT_GRACE_MINUTES = 60;

// How many scheduled times a strip looks at, so a schedule that fires every
// minute costs no more than any other.
const MAX_TIMES_LOOKED_AT = 200;

// One cell of a strip: a run that succeeded or failed, at its start, or a
// scheduled time that passed with no run.
export type StripCell = { at: number; kind: 'failed' | 'missed' | 'ok' };

// The scheduled times, newest first, that no run followed within `graceMs`,
// looking back no further than `notBefore`, when the Hub first mirrored the
// job. Grace is wall-clock time here; the Hub counts the System's awake time
// for Job overdue, so a System that slept is judged more kindly there.
const missedTimes = ({
  graceMs,
  limit,
  notBefore,
  now,
  runs,
  schedule,
  timeZone,
}: {
  graceMs: number;
  limit: number;
  notBefore: number;
  now: number;
  runs: readonly JobRun[];
  schedule: readonly ScheduleEntry[];
  timeZone: string;
}): number[] => {
  const missed: number[] = [];
  let atOrBefore = now - graceMs;
  for (let looked = 0; looked < MAX_TIMES_LOOKED_AT && missed.length < limit; looked += 1) {
    let time: number | undefined;
    try {
      time = latestScheduledTime({ atOrBefore, notBefore, schedule, timeZone });
    } catch {
      // A zone this runtime does not know.
      return missed;
    }
    if (time === undefined) {
      break;
    }
    const scheduled = time;
    if (!runs.some(({ started }) => started >= scheduled && started <= scheduled + graceMs)) {
      missed.push(scheduled);
    }
    atOrBefore = scheduled - 1;
  }
  return missed;
};

// The newest `limit` cells of a job, oldest first: its runs and the scheduled
// times they missed. A scheduled time is missed when no run started within
// `graceMs` after it, and it has been that long. Without a zone no schedule can
// be read, so only the runs show. `runs` holds the job's newest runs.
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
  const missed =
    timeZone === null
      ? []
      : missedTimes({ graceMs, limit, notBefore, now, runs, schedule, timeZone }).map(
          (at): StripCell => ({ at, kind: 'missed' }),
        );
  return [...ran, ...missed].toSorted((a, b) => a.at - b.at).slice(-limit);
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const clock = (hour: number, minute: number) =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

// A schedule in a few words: "daily 03:00", "Sun 10:05", "day 1 04:30",
// "hourly :15", or the count of its times when it has several entries.
export const scheduleWords = (schedule: readonly ScheduleEntry[]): string => {
  const [entry, ...rest] = schedule;
  if (entry === undefined) {
    return 'no schedule';
  }
  if (rest.length > 0) {
    return `${String(schedule.length)} times`;
  }
  const { day, hour, minute, month, weekday } = entry;
  if (minute === undefined || month !== undefined) {
    return 'scheduled';
  }
  if (hour === undefined) {
    return day === undefined && weekday === undefined
      ? `hourly :${String(minute).padStart(2, '0')}`
      : 'scheduled';
  }
  if (weekday !== undefined) {
    return `${WEEKDAYS[weekday % 7] ?? ''} ${clock(hour, minute)}`;
  }
  return day === undefined
    ? `daily ${clock(hour, minute)}`
    : `day ${String(day)} ${clock(hour, minute)}`;
};

// How long a run took: "<1 s", "18 s", "4 m 12 s", or "1 h 3 m".
export const runLength = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) {
    return '<1 s';
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} m`;
  }
  if (minutes > 0) {
    return rest === 0 ? `${String(minutes)} m` : `${String(minutes)} m ${String(rest)} s`;
  }
  return `${String(seconds)} s`;
};

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

// When the latest run finished and how long it took: "03:00 · 4 m 12 s · exit
// 1", the day too when it is not today; undefined for a job that never ran.
export const latestRunWords = ({ latestRun }: Latest, now: number): Phrase | undefined =>
  latestRun === undefined
    ? undefined
    : [
        whenAt(latestRun.finished, now),
        ` · ${runLength(latestRun.finished - latestRun.started)} · exit ${String(latestRun.exitStatus)}`,
      ];

// When the job is next due; for an overdue job when it was due and how long
// the Hub waits for a run.
export const dueWords = (job: Due, now: number): Phrase => {
  if (job.state === 'overdue' && job.wasDueAt !== undefined) {
    return ['was due ', whenAt(job.wasDueAt, now), ` · grace ${String(job.graceMinutes)} m`];
  }
  return job.nextDue === undefined ? ['unknown'] : [{ at: job.nextDue, format: 'ahead', now }];
};
