import { once } from 'node:events';

import { every, homeOf, keepLogRotated, runtimeLog, servicePaths } from '@heimdall/service';
import type { RuntimeLog } from '@heimdall/service';
import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { serve } from './application.ts';
import { openDatabase } from './database.ts';
import { describeError } from './errors.ts';
import { evaluateConditions } from './evaluate-conditions.ts';
import { createHub } from './hub.ts';
import { describeLockWait, migrateWhenFree } from './migration-wait.ts';
import { projectTranscripts } from './projection.ts';
import { pruneVitals } from './retention.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { pairedSystemCount } from './tokens.ts';

const PRUNE_INTERVAL_MS = 3_600_000;
const CONDITIONS_INTERVAL_MS = 60_000;
// Collectors scan their transcripts every 60 seconds, so Session insight lags
// an upload by at most this; a rebuild parses a budget each time.
const PROJECT_INTERVAL_MS = 15_000;

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
    // The Hub does not listen until the migrations apply. A lock another session
    // holds, such as a backup's, is waited out and logged, not a failure.
    // PostgreSQL's messages name the host and role, never the password.
    const applied = await migrateWhenFree(sql, {
      onBlocked: (holders) => log.warn(clean(describeLockWait(holders))),
      signal,
    }).catch((error: unknown) =>
      signal.aborted
        ? undefined
        : log.fatal(clean(`Could not prepare the database: ${describeError(error)}`)),
    );
    if (applied === undefined) {
      return;
    }
    if (applied.length > 0) {
      await log.info(`Applied database migrations ${applied.join(', ')}.`);
    }
    // A stop that landed as the migrations finished must not start listening.
    if (signal.aborted) {
      return;
    }
    const hub = createHub({
      now: Date.now,
      onError: (error) => {
        void log.warn(clean(`Could not answer a request: ${describeError(error)}`));
      },
      sql,
    });
    const server = Bun.serve({ fetch: hub.fetch, hostname: options.host, port: options.port });
    // Pruning, judging Conditions, and parsing transcripts are routine, so only
    // a failure or a parser switch is logged, and the next round tries again.
    let stopPruning: (() => Promise<void>) | undefined;
    let stopJudging: (() => Promise<void>) | undefined;
    let stopProjecting: (() => Promise<void>) | undefined;
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
        task: () => evaluateConditions(sql, Date.now, SYSTEM_CONDITION_THRESHOLDS),
      });
      stopProjecting = every({
        intervalMs: PROJECT_INTERVAL_MS,
        onError: (error) => {
          void log.warn(clean(`Could not derive Session insight: ${describeError(error)}`));
        },
        task: async () => {
          const { switched } = await projectTranscripts(sql);
          for (const { harness, version } of switched) {
            // oxlint-disable-next-line no-await-in-loop -- one line per switch, in order.
            await log.info(
              clean(`Session insight for ${harness} now reads parser version ${String(version)}.`),
            );
          }
        },
      });
      if (!signal.aborted) {
        await once(signal, 'abort');
      }
    } finally {
      // A prune, judgment, or parse still running must finish before the database closes.
      await stopPruning?.();
      await stopJudging?.();
      await stopProjecting?.();
      await server.stop();
    }
  } finally {
    await sql.close();
  }
};
