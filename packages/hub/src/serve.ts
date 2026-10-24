import { once } from 'node:events';

import {
  every,
  homeOf,
  keepLogRotated,
  listenOrFail,
  runtimeLog,
  servicePaths,
} from '@heimdall/service';
import type { RuntimeLog } from '@heimdall/service';
import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { serve } from './application.ts';
import { configName } from './commands.ts';
import { readConditionLimits, storeConditionLimits } from './condition-limits.ts';
import type { ConditionLimits } from './condition-limits.ts';
import { openDatabase } from './database.ts';
import { readDeliveryChannel } from './delivery-config.ts';
import type { DeliveryChannel } from './delivery-config.ts';
import { clearFailingRun, deliverAlerts } from './delivery.ts';
import { describeError } from './errors.ts';
import { evaluateConditions } from './evaluate-conditions.ts';
import { createHub } from './hub.ts';
import { keepInsightReaderGranted } from './insight-reader.ts';
import { recordListening } from './listening.ts';
import { describeLockWait, migrateWhenFree } from './migration-wait.ts';
import { ntfySender } from './ntfy.ts';
import { loadPriceOverrides, syncPrices } from './price-table.ts';
import { BUNDLED_PRICES } from './prices.ts';
import type { PriceEntry } from './prices.ts';
import { projectionNotes, projectTranscripts } from './projection.ts';
import { pruneServiceStops, pruneVitals } from './retention.ts';
import { refreshSessionInsight } from './stored-insight.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { pairedSystemCount } from './tokens.ts';

const PRUNE_INTERVAL_MS = 3_600_000;
const CONDITIONS_INTERVAL_MS = 60_000;
// How often serve records that it is listening, well inside the gap that
// counts as an outage (LISTENING_GAP_MS).
const LISTENING_INTERVAL_MS = 30_000;
// How often serve compares stored Conditions with its deliveries. A failed send
// is tried again this much later.
const DELIVERY_INTERVAL_MS = 30_000;
// How often serve parses transcripts. When it keeps up, Session insight trails
// an upload by about this; a backlog or a rebuild parses at most a budget each
// time, so it trails further until it catches up.
const PROJECT_INTERVAL_MS = 15_000;

const systemCount = (n: number) => `${String(n)} ${n === 1 ? 'System' : 'Systems'}`;

// `heimdall-hub serve`: brings the database to the latest schema, then accepts
// Reports and transcripts until systemd or a terminal stops it. Its runtime
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
    const named = configName(options);
    const limits = await readConditionLimits({ cwd: host.cwd, env: host.env, named }).catch(
      (error: unknown) => log.fatal(clean(`Invalid Hub Condition limits: ${describeError(error)}`)),
    );
    const delivery = await readDeliveryChannel({ cwd: host.cwd, env: host.env, named }).catch(
      (error: unknown) =>
        log.fatal(clean(`Invalid Hub delivery settings: ${describeError(error)}`)),
    );
    await serveUntilStopped({ clean, delivery, limits, log, options, signal });
  } finally {
    await stopRotating();
  }
};

// The prices the configuration adds, none when it names no file. A file that
// cannot be read is fatal.
const loadConfiguredPrices = async (
  path: string | undefined,
  log: RuntimeLog,
  clean: (message: string) => string,
): Promise<PriceEntry[]> => {
  if (path === undefined) {
    return [];
  }
  try {
    return await loadPriceOverrides(path);
  } catch (error) {
    return log.fatal(clean(describeError(error)));
  }
};

const serveUntilStopped = async ({
  clean,
  delivery,
  limits,
  log,
  options,
  signal,
}: {
  clean: (message: string) => string;
  delivery: DeliveryChannel | undefined;
  limits: ConditionLimits;
  log: RuntimeLog;
  options: Parameters<ActionHandler<typeof serve>>[0]['options'];
  signal: AbortSignal;
}) => {
  // A price overrides file that cannot be read stops the Hub before it touches
  // the database, since cost would otherwise read at the wrong prices.
  const configuredPrices = await loadConfiguredPrices(options['price-overrides'], log, clean);
  const sql = openDatabase(options.database);
  let stopGranting: (() => Promise<void>) | undefined;
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
    // PostgreSQL's messages name the host and role, never the password.
    await syncPrices(sql, { bundled: BUNDLED_PRICES, configured: configuredPrices }).catch(
      (error: unknown) =>
        log.fatal(clean(`Could not load the price table: ${describeError(error)}`)),
    );
    await storeConditionLimits(sql, limits).catch((error: unknown) =>
      log.fatal(clean(`Could not store the Condition limits: ${describeError(error)}`)),
    );
    // Turning delivery off must not leave the dashboard saying it is failing.
    if (delivery === undefined) {
      await clearFailingRun(sql).catch((error: unknown) =>
        log.fatal(clean(`Could not clear the delivery status: ${describeError(error)}`)),
      );
    }
    // The insight reader is granted after the migrations, so it covers every
    // view they made. Neither a reader not created yet nor a failed grant stops
    // the Hub; both are tried again while it runs.
    const reader = options['insight-reader'];
    if (reader !== undefined) {
      stopGranting = await keepInsightReaderGranted({ clean, log, reader, sql });
    }
    const hub = createHub({
      now: Date.now,
      onError: (error) => {
        void log.warn(clean(`Could not answer a request: ${describeError(error)}`));
      },
      sql,
    });
    const server = listenOrFail({
      fail: (message) => log.fatal(clean(message)),
      fetch: hub.fetch,
      hostname: options.host,
      port: options.port,
    });
    // Pruning, judging Conditions, delivering alerts, and parsing transcripts
    // are routine, so only a failure, a parser switch, or a parser left behind
    // is logged, and the next round tries again.
    let stopListening: (() => Promise<void>) | undefined;
    let stopPruning: (() => Promise<void>) | undefined;
    let stopJudging: (() => Promise<void>) | undefined;
    let stopDelivering: (() => Promise<void>) | undefined;
    let stopProjecting: (() => Promise<void>) | undefined;
    let stopRefreshing: (() => Promise<void>) | undefined;
    const outdatedLogged = new Set<string>();
    try {
      const paired = await pairedSystemCount(sql);
      await log.info(clean(`Listening on ${server.url.href} for ${systemCount(paired)}.`));
      stopListening = every({
        intervalMs: LISTENING_INTERVAL_MS,
        onError: (error) => {
          void log.warn(
            clean(`Could not record that the Hub is listening: ${describeError(error)}`),
          );
        },
        task: () => recordListening(sql, Date.now()),
      });
      stopPruning = every({
        intervalMs: PRUNE_INTERVAL_MS,
        onError: (error) => {
          void log.warn(
            clean(`Could not prune old Vitals and Service stops: ${describeError(error)}`),
          );
        },
        task: async () => {
          const now = Date.now();
          await pruneVitals(sql, now);
          await pruneServiceStops(sql, now);
        },
      });
      stopJudging = every({
        intervalMs: CONDITIONS_INTERVAL_MS,
        onError: (error) => {
          void log.warn(clean(`Could not judge Conditions: ${describeError(error)}`));
        },
        // Recording first means no judgment runs unless the Hub could record
        // that it listens, so none misses an outage the record would reveal.
        task: async () => {
          await recordListening(sql, Date.now());
          await evaluateConditions(sql, Date.now, { ...SYSTEM_CONDITION_THRESHOLDS, ...limits });
        },
      });
      if (delivery !== undefined) {
        // The server's host is no secret; the topic and token never reach the log.
        await log.info(clean(`Delivering alerts through ${delivery.url.host}.`));
        const send = ntfySender(delivery);
        stopDelivering = every({
          intervalMs: DELIVERY_INTERVAL_MS,
          onError: (error) => {
            void log.warn(clean(`Could not deliver alerts: ${describeError(error)}`));
          },
          task: () => deliverAlerts(sql, { dashboard: delivery.dashboard, now: Date.now(), send }),
        });
      }
      stopProjecting = every({
        intervalMs: PROJECT_INTERVAL_MS,
        onError: (error) => {
          void log.warn(clean(`Could not derive Session insight: ${describeError(error)}`));
        },
        task: async () => {
          const projected = await projectTranscripts(sql);
          for (const { level, text } of projectionNotes(projected, outdatedLogged)) {
            // oxlint-disable-next-line no-await-in-loop -- one line at a time, in order.
            await (level === 'info' ? log.info(clean(text)) : log.warn(clean(text)));
          }
        },
      });
      stopRefreshing = every({
        intervalMs: PROJECT_INTERVAL_MS,
        onError: (error) => {
          void log.warn(clean(`Could not store Session insight: ${describeError(error)}`));
        },
        task: () => refreshSessionInsight(sql),
      });
      if (!signal.aborted) {
        await once(signal, 'abort');
      }
    } finally {
      // A record, prune, judgment, delivery, parse, or refresh still running must finish before the database closes.
      await stopListening?.();
      await stopPruning?.();
      await stopJudging?.();
      await stopDelivering?.();
      await stopProjecting?.();
      await stopRefreshing?.();
      await server.stop();
    }
  } finally {
    await stopGranting?.();
    await sql.close();
  }
};
