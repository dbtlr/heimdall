// What the Jobs page reads. Three statements over every paired System, so
// their count does not grow with Systems or jobs. Each job's runs are its
// newest STRIP_RUNS only, found by the key of the run table. One lookup, the
// oldest run received since the job was last first mirrored, reads a job's
// stored runs, so its cost grows with the runs the Hub keeps for that job,
// bounded by the 90-day prune (tens of milliseconds for a job with 130,000
// runs).

import { latestScheduledTime, nextScheduledTime } from '@heimdall/schema';
import type { SQL } from 'bun';

import { homeJob, orderJobs } from '../lib/home-jobs.ts';
import { DEFAULT_GRACE_MINUTES, jobStrip, STRIP_RUNS } from '../lib/jobs.ts';
import { inSnapshot } from './fleet-overview.ts';
import { field, scheduleOf, text, toRun } from './hub-rows.ts';
import type { RunRow } from './hub-rows.ts';
import type { Jobs, JobsRow } from './jobs-types.ts';
import type { JobRun } from './system-detail-types.ts';

const DAY_MS = 86_400_000;

// How long the Hub keeps every run of a job; past it, only the job's latest
// STRIP_RUNS stay. The Collector keeps the same 90 days and sends them all, so
// the history holds every run of these days, and none from before it says
// anything about them.
const HISTORY_MS = 90 * DAY_MS;

type JobRow = {
  first_mirrored_at: Date | null;
  oldest_run_since_mirrored: Date | null;
  latest_run: RunRow['latest_run'] | null;
  name: string;
  record: unknown;
  system: string;
  time_zone: string | null;
};

type OpenRow = { kind: string; raised_at: Date; subject: string; system: string };

type StoredRunRow = {
  exit_status: number;
  finished_at: Date;
  job: string;
  started_at: Date;
  system: string;
};

const keyOf = (system: string, job: string) => JSON.stringify([system, job]);

const readJobRows = (sql: SQL): Promise<JobRow[]> => sql`
  SELECT r.system, r.name, r.record, u.latest_run, s.time_zone, f.first_mirrored_at,
    (
      SELECT min(j.started_at) FROM job_runs j
      WHERE j.system = r.system AND j.job = r.name AND j.received_at >= f.first_mirrored_at
    ) AS oldest_run_since_mirrored
  FROM mirrored_records r
  JOIN paired_systems p ON p.system = r.system
  LEFT JOIN mirrored_runs u ON u.system = r.system AND u.job = r.name
  LEFT JOIN systems s ON s.name = r.system
  LEFT JOIN records_first_mirrored f
    ON f.system = r.system AND f.kind = 'job' AND f.name = r.name
  WHERE r.kind = 'job'
`;

const readOpenJobConditions = (sql: SQL): Promise<OpenRow[]> => sql`
  SELECT c.system, c.subject, c.kind, c.raised_at
  FROM conditions c
  JOIN paired_systems p ON p.system = c.system
  WHERE c.kind IN ('job_failing', 'job_overdue') AND c.cleared_at IS NULL
`;

// Each recorded job's newest STRIP_RUNS runs, newest first, by the run table's
// key (system, job, started_at).
const readStoredRuns = (sql: SQL): Promise<StoredRunRow[]> => sql`
  SELECT j.system, j.job, r.started_at, r.finished_at, r.exit_status
  FROM (
    SELECT m.system, m.name AS job
    FROM mirrored_records m
    JOIN paired_systems p ON p.system = m.system
    WHERE m.kind = 'job'
  ) j
  CROSS JOIN LATERAL (
    SELECT started_at, finished_at, exit_status
    FROM job_runs
    WHERE system = j.system AND job = j.job
    ORDER BY started_at DESC
    LIMIT ${STRIP_RUNS}
  ) r
`;

const toStoredRun = (row: StoredRunRow): JobRun => ({
  exitStatus: row.exit_status,
  finished: row.finished_at.getTime(),
  started: row.started_at.getTime(),
});

// The earliest time a job's strip can call a scheduled time missed: no earlier
// than the job existed, and no earlier than the history speaks for. The
// history speaks for every scheduled time since its oldest run when it holds
// STRIP_RUNS of them, since it keeps all later runs; with fewer, it speaks for
// the 90 days a Collector sends and no further back, even when it holds an
// older run: a Collector keeps a job's latest success past its 90 days, but
// pruned the runs around it unsent.
const missedSince = ({
  existed,
  history,
  now,
}: {
  existed: number;
  history: readonly JobRun[];
  now: number;
}): number => {
  const starts = history.map(({ started }) => started);
  const held = history.length >= STRIP_RUNS ? Math.min(...starts) : now - HISTORY_MS;
  return Math.max(existed, held);
};

// The job as the page lists it. Its latest run and state come from the latest
// run the Hub mirrors and the job Conditions, as on Home and in the Hub's
// judgment; the history lists the earlier runs, with the latest run added when
// the history does not hold it yet. A System whose Collector has sent no
// history has no strip, since its earlier runs are unknown, not missed.
const jobRow = (
  row: JobRow,
  {
    history,
    now,
    opened,
    sendsHistory,
  }: {
    history: readonly JobRun[];
    now: number;
    opened: ReadonlyMap<string, number>;
    sendsHistory: boolean;
  },
): JobsRow => {
  const schedule = scheduleOf(field(row.record, 'schedule'));
  const graceMinutes = field(row.record, 'graceMinutes');
  const grace = typeof graceMinutes === 'number' ? graceMinutes : DEFAULT_GRACE_MINUTES;
  const graceMs = grace * 60_000;
  const latestRun = row.latest_run === null ? undefined : toRun(row.latest_run);
  const timeZone = row.time_zone;
  const timed = <T>(find: (zone: string) => T | undefined) => {
    if (timeZone === null) {
      return undefined;
    }
    try {
      return find(timeZone);
    } catch {
      // A zone this runtime does not know.
      return undefined;
    }
  };
  const overdueSince = opened.get(`${keyOf(row.system, row.name)}/job_overdue`);
  const home = homeJob({
    dueAt: undefined,
    failing: opened.has(`${keyOf(row.system, row.name)}/job_failing`),
    latestRun,
    name: row.name,
    overdueSince,
    system: row.system,
  });
  // The job existed from when the Hub first mirrored it, or from any run the
  // Hub received since then, such as the Collector's first backlog, which can
  // span several Reports. A run the Hub stored before a record was forgotten
  // and recorded again (a Report left it out, a later one listed it, and
  // `forget` kept its runs) does not count: the gap is not the job's missed
  // times. Two limits are known. (a) When a forget and the re-record both
  // happen before the Hub sees a Report without the record (inside one Report
  // window, or while the Collector cannot reach the Hub), the Hub never resets
  // the mirror start, and the gap still counts as missed. (b) Runs the Hub
  // received before it first mirrored the job's record (for example while the
  // records section was over budget) do not lower the floor, so a miss among
  // them is not shown.
  const earlierRuns =
    row.first_mirrored_at === null
      ? history.map(({ started }) => started)
      : [row.oldest_run_since_mirrored?.getTime() ?? Infinity];
  const existed = Math.min(row.first_mirrored_at?.getTime() ?? now - HISTORY_MS, ...earlierRuns);
  const runs =
    latestRun === undefined || history.some(({ started }) => started === latestRun.started)
      ? history
      : [latestRun, ...history];
  return {
    ...home,
    graceMinutes: grace,
    latestRun,
    nextDue: timed((zone) => nextScheduledTime({ after: now, schedule, timeZone: zone })),
    schedule,
    scheduler: text(field(row.record, 'scheduler')) ?? '',
    strip: sendsHistory
      ? jobStrip({
          graceMs,
          notBefore: missedSince({ existed, history, now }),
          now,
          runs,
          schedule,
          timeZone,
        })
      : undefined,
    timeZone,
    // The Hub is overdue for a time its grace has passed since; on the wall
    // clock that is the latest at least the grace ago, which for a System that
    // slept can be later than the time the Hub names.
    wasDueAt:
      overdueSince === undefined
        ? undefined
        : timed((zone) =>
            latestScheduledTime({
              atOrBefore: now - graceMs,
              notBefore: existed,
              schedule,
              timeZone: zone,
            }),
          ),
  };
};

// Every job a paired System's provisioner recorded, failing first, then
// overdue, then by latest run, at `now`.
const readJobsSnapshot = async (sql: SQL, now: number): Promise<Jobs> => {
  const [rows, open, stored] = await Promise.all([
    readJobRows(sql),
    readOpenJobConditions(sql),
    readStoredRuns(sql),
  ]);
  const opened = new Map(
    open.map((row) => [`${keyOf(row.system, row.subject)}/${row.kind}`, row.raised_at.getTime()]),
  );
  const historyOf = new Map<string, JobRun[]>();
  for (const row of stored) {
    const key = keyOf(row.system, row.job);
    historyOf.set(key, [...(historyOf.get(key) ?? []), toStoredRun(row)]);
  }
  // A Collector sends every run it keeps, so a System with a stored run of any
  // job it records sends the history, and its other jobs have none to send.
  const sendingHistory = new Set(stored.map(({ system }) => system));
  return {
    jobs: orderJobs(
      rows.map((row) =>
        jobRow(row, {
          history: (historyOf.get(keyOf(row.system, row.name)) ?? []).toSorted(
            (a, b) => b.started - a.started,
          ),
          now,
          opened,
          sendsHistory: sendingHistory.has(row.system),
        }),
      ),
    ),
    now,
  };
};

// One snapshot, so a run stored between the reads cannot leave a job's state
// disagreeing with its strip.
export const readJobs = inSnapshot(readJobsSnapshot);
