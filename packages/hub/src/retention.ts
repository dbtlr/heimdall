import type { SQL } from 'bun';

const DAY_MS = 86_400_000;

// How long the Hub keeps each kind of Vitals row (ADR-0008): raw samples for
// 14 days, and the 5-minute rollups they feed for a year.
export const RAW_RETENTION_MS = 14 * DAY_MS;
export const ROLLUP_RETENTION_MS = 365 * DAY_MS;

export type Pruned = {
  diskRollups: number;
  processRollups: number;
  processSamples: number;
  samples: number;
  vitalsRollups: number;
};

// Deletes the Vitals older than their retention at `now` (epoch milliseconds):
// samples with `t`, and rollups with `bucket`, strictly before the cutoff. A row
// exactly at the cutoff stays until the next prune. Harness process samples and
// their rollups are on the Vitals time axis and follow the same retention; the
// process rows stay. Returns the rows deleted.
export const pruneVitals = (sql: SQL, now: number): Promise<Pruned> =>
  sql.begin(async (tx) => {
    const rawCutoff = new Date(now - RAW_RETENTION_MS);
    const rollupCutoff = new Date(now - ROLLUP_RETENTION_MS);
    const samples = await tx`DELETE FROM vitals_samples WHERE t < ${rawCutoff}`;
    const vitalsRollups = await tx`DELETE FROM vitals_rollups WHERE bucket < ${rollupCutoff}`;
    const diskRollups = await tx`DELETE FROM disk_rollups WHERE bucket < ${rollupCutoff}`;
    const processSamples = await tx`DELETE FROM harness_process_samples WHERE t < ${rawCutoff}`;
    const processRollups =
      await tx`DELETE FROM harness_process_rollups WHERE bucket < ${rollupCutoff}`;
    return {
      diskRollups: diskRollups.count,
      processRollups: processRollups.count,
      processSamples: processSamples.count,
      samples: samples.count,
      vitalsRollups: vitalsRollups.count,
    };
  });

// Retention follows stopped_at, not when an ended view arrives. An ongoing
// stop stays however old it is, so a later Report can settle it (ADR-0021).
export const pruneServiceStops = async (sql: SQL, now: number): Promise<number> => {
  const cutoff = new Date(now - 90 * DAY_MS);
  const deleted = await sql`DELETE FROM service_stops WHERE NOT ongoing AND stopped_at < ${cutoff}`;
  return deleted.count;
};

// How long the Hub keeps a job run, counted from its `started`, unless the run
// is among its job's latest runs (ADR-0023).
export const JOB_RUN_RETENTION_DAYS = 90;

// How many of each job's latest runs the Hub keeps however old they are, so a
// job that runs weekly or less often still shows its recent runs (ADR-0023).
export const JOB_RUNS_KEPT_PER_JOB = 14;

// Deletes the job runs past their retention at `now` (epoch milliseconds). A
// run goes when it started more than 90 days before `now` and 14 later runs
// of its job exist. The latest runs are found through the primary key, which
// leads with System, job, and start, and the old candidates through the index
// on the start, so the cost follows the runs old enough to go.
export const pruneJobRuns = async (sql: SQL, now: number): Promise<number> => {
  const cutoff = new Date(now - JOB_RUN_RETENTION_DAYS * DAY_MS);
  const deleted = await sql`
    DELETE FROM job_runs old
    WHERE old.started_at < ${cutoff}
      AND (
        SELECT count(*) FROM (
          SELECT 1 FROM job_runs later
          WHERE later.system = old.system AND later.job = old.job AND later.started_at > old.started_at
          LIMIT ${JOB_RUNS_KEPT_PER_JOB}
        ) AS latest
      ) >= ${JOB_RUNS_KEPT_PER_JOB}
  `;
  return deleted.count;
};
