import type { SQL } from 'bun';

import { clear, evaluateEach, raise } from './conditions.ts';

const QUIET_MS = 24 * 60 * 60_000;

// One Service's latest run of stops, separated by no more than 24 hours.
export type StopRun = {
  service: string;
  first_stopped_at: Date;
  stopped_at: Date;
  received_at: Date;
  stops: number;
  restarts: number;
  result: string | null;
  exit_status: number | null;
  ongoing: boolean;
};

const utcMinute = (at: Date) => `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

const reasonOf = (run: StopRun) => {
  const when =
    run.stops === 1
      ? `once at ${utcMinute(run.stopped_at)}`
      : `${String(run.stops)} times, first at ${utcMinute(run.first_stopped_at)} and last at ${utcMinute(run.stopped_at)}`;
  let result = 'The latest result is unknown';
  if (run.result === 'success') {
    result = 'It last stopped cleanly';
  } else if (run.result !== null) {
    const status =
      run.exit_status === null ? 'exit status unknown' : `exit status ${String(run.exit_status)}`;
    result = `It last failed (${run.result}, ${status})`;
  }
  const restarts =
    run.restarts === 0
      ? ''
      : `, with ${String(run.restarts)} automatic restart${run.restarts === 1 ? '' : 's'} in total`;
  const ongoing = run.ongoing ? '; it is still stopped' : '';
  return `The Service stopped ${when}. ${result}${restarts}${ongoing}.`;
};

// What one System's service_restarted Conditions are judged on, as read under
// its row lock.
export type ServiceStopFacts = {
  // The Hub's clock, in epoch milliseconds.
  now: number;
  // The Services whose service_restarted Condition is open.
  open: readonly string[];
  // Each Service's latest run of stops.
  runs: readonly StopRun[];
};

// Judges one System's service_restarted Conditions: each Service whose latest
// run of stops began or ended, by its stop or its Report, within 24 hours of
// `now` is raised with the run described, and an open Condition of a Service
// with no such run is cleared. The Hub's clock, not a later check, expires a
// run.
export const judgeServiceStops = (
  facts: ServiceStopFacts,
): Map<string, { raise: string } | 'clear'> => {
  const judged = new Map<string, { raise: string } | 'clear'>();
  const recent = facts.runs.filter(
    (run) => facts.now - Math.min(run.stopped_at.getTime(), run.received_at.getTime()) < QUIET_MS,
  );
  for (const run of recent) {
    judged.set(run.service, { raise: reasonOf(run) });
  }
  for (const subject of facts.open) {
    if (!recent.some((run) => run.service === subject)) {
      judged.set(subject, 'clear');
    }
  }
  return judged;
};

// Raises and clears one System's service_restarted Conditions. The System lock
// orders evaluation with Reports and purges, and the Hub's clock is read after
// locking. A System with no row is left alone.
const evaluateSystem = (sql: SQL, system: string, clock: () => number) =>
  sql.begin(async (tx) => {
    const [held]: { name: string }[] = await tx`
      SELECT name FROM systems WHERE name = ${system} FOR UPDATE
    `;
    if (held === undefined) {
      return;
    }
    const now = clock();
    // Recent Services need their full history to count the latest run of stops.
    const runs: StopRun[] = await tx`
      WITH gaps AS (
        SELECT *, lag(stopped_at) OVER (PARTITION BY service ORDER BY stopped_at) AS previous_at
        FROM service_stops
        WHERE system = ${system} AND service IN (
          SELECT service FROM service_stops
          WHERE system = ${system} AND stopped_at > ${new Date(now - QUIET_MS)}
        )
      ), runs AS (
        SELECT *, sum(CASE WHEN previous_at IS NULL OR stopped_at - previous_at > interval '24 hours'
                          THEN 1 ELSE 0 END)
          OVER (PARTITION BY service ORDER BY stopped_at) AS run
        FROM gaps
      )
      SELECT DISTINCT ON (service) service, stopped_at, received_at, ongoing, result, exit_status,
        min(stopped_at) OVER (PARTITION BY service, run) AS first_stopped_at,
        (count(*) OVER (PARTITION BY service, run))::integer AS stops,
        (sum(restarts) OVER (PARTITION BY service, run))::double precision AS restarts
      FROM runs ORDER BY service, stopped_at DESC
    `;
    const open: { subject: string }[] = await tx`
      SELECT subject FROM conditions
      WHERE system = ${system} AND kind = 'service_restarted' AND cleared_at IS NULL
    `;
    const judged = judgeServiceStops({ now, open: open.map((row) => row.subject), runs });
    const at = new Date(now);
    for (const [subject, verdict] of judged) {
      if (verdict === 'clear') {
        // oxlint-disable-next-line no-await-in-loop -- judgments share the System transaction.
        await clear(tx, { kind: 'service_restarted', now: at, subject, system });
      } else {
        // oxlint-disable-next-line no-await-in-loop -- judgments share the System transaction.
        await raise(tx, {
          kind: 'service_restarted',
          now: at,
          reason: verdict.raise,
          subject,
          system,
        });
      }
    }
  });

// Every System that holds a stop or an open note is evaluated, paired or not,
// since a Report can carry stops without checks. A failing System does not
// prevent the others from being judged.
export const evaluateServiceStopConditions = async (
  sql: SQL,
  clock: () => number,
): Promise<void> => {
  const systems: { system: string }[] = await sql`
    SELECT system FROM service_stops
    UNION
    SELECT system FROM conditions WHERE kind = 'service_restarted' AND cleared_at IS NULL
    ORDER BY system
  `;
  await evaluateEach(
    systems.map((row) => row.system),
    (system) => evaluateSystem(sql, system, clock),
  );
};
