import { once } from 'node:events';

import { every, homeOf, keepLogRotated, runtimeLog, servicePaths } from '@heimdall/service';
import type { RuntimeLog } from '@heimdall/service';
import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';
import type { SQL } from 'bun';

import type { serve } from './application.ts';
import { openDatabase } from './database.ts';
import { describeError } from './errors.ts';
import { createHub } from './hub.ts';
import { evaluateJobConditions } from './job-conditions.ts';
import { migrate } from './migrations.ts';
import { pruneVitals } from './retention.ts';
import { evaluateSystemConditions, SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { pairedSystemCount } from './tokens.ts';

const PRUNE_INTERVAL_MS = 3_600_000;
const CONDITIONS_INTERVAL_MS = 60_000;

// Judges the job Conditions and the System Conditions. One failing does not
// keep the other from running; the error then carries both.
const judgeConditions = async (sql: SQL) => {
  const results = await Promise.allSettled([
    evaluateJobConditions(sql, Date.now),
    evaluateSystemConditions(sql, Date.now, SYSTEM_CONDITION_THRESHOLDS),
  ]);
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map(describeError).join('; '));
  }
};

const systemCount = (n: number) => `${String(n)} ${n === 1 ? 'System' : 'Systems'}`;

// `heimdall-hub serve`: brings the database to the latest schema, then accepts
// Reports and serves the page until systemd or a terminal stops it. Its runtime
// lines, fatal ones included, start with their time. It rotates its supervised
// log before writing its first line, then about once a day.
export const serveAction: ActionHandler<typeof serve> = async ({
  host,
  options,
  out,
  signal,
  style,
}) => {
  const clean = (message: string) => style.escape(escapeControlCharacters(message));
  const log = runtimeLog({ fatal: (line) => out.fatal(line), print: (line) => out.print(line) });
  // Rotation is routine, so only a failure is logged, and the next day tries again.
  const stopRotating = await keepLogRotated({
    onError: (error) => {
      void log.warn(clean(`Could not rotate the log: ${describeError(error)}`));
    },
    path: servicePaths('hub', homeOf(host.env)).log,
  });
  try {
    await serveUntilStopped({ clean, log, options, signal });
  } finally {
    await stopRotating();
  }
};

const serveUntilStopped = async ({
  clean,
  log,
  options,
  signal,
}: {
  clean: (message: string) => string;
  log: RuntimeLog;
  options: Parameters<ActionHandler<typeof serve>>[0]['options'];
  signal: AbortSignal;
}) => {
  const sql = openDatabase(options.database);
  try {
    // PostgreSQL's messages name the host and role, never the password.
    const applied = await migrate(sql).catch((error: unknown) =>
      log.fatal(clean(`Could not prepare the database: ${describeError(error)}`)),
    );
    if (applied.length > 0) {
      await log.info(`Applied database migrations ${applied.join(', ')}.`);
    }
    const hub = createHub({
      now: Date.now,
      onError: (error) => {
        void log.warn(clean(`Could not answer a request: ${describeError(error)}`));
      },
      sql,
    });
    const server = Bun.serve({ fetch: hub.fetch, hostname: options.host, port: options.port });
    // Pruning and judging Conditions are routine, so only a failure is logged, and
    // the next round tries again.
    let stopPruning: (() => Promise<void>) | undefined;
    let stopJudging: (() => Promise<void>) | undefined;
    try {
      const paired = await pairedSystemCount(sql);
      await log.info(clean(`Listening on ${server.url.href} for ${systemCount(paired)}.`));
      stopPruning = every({
        intervalMs: PRUNE_INTERVAL_MS,
        onError: (error) => {
          void log.warn(clean(`Could not prune old Vitals: ${describeError(error)}`));
        },
        task: () => pruneVitals(sql, Date.now()),
      });
      stopJudging = every({
        intervalMs: CONDITIONS_INTERVAL_MS,
        onError: (error) => {
          void log.warn(clean(`Could not judge Conditions: ${describeError(error)}`));
        },
        task: () => judgeConditions(sql),
      });
      if (!signal.aborted) {
        await once(signal, 'abort');
      }
    } finally {
      // A prune or judgment still running must finish before the database closes.
      await stopPruning?.();
      await stopJudging?.();
      await server.stop();
    }
  } finally {
    await sql.close();
  }
};
