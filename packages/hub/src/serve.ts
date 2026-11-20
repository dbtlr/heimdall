import { once } from 'node:events';

import { every, keepLogRotated, listenOrFail, runtimeLog, servicePaths } from '@heimdall/service';
import type { RuntimeLog } from '@heimdall/service';
import { escapeControlCharacters } from '@loomcli/core';
import type { ActionHandler } from '@loomcli/core';

import type { serve } from './application.ts';
import { parseConditionLimits, storeConditionLimits } from './condition-limits.ts';
import type { ConditionLimits } from './condition-limits.ts';
import { openDatabase, STATEMENT_TIMEOUT_MS } from './database.ts';
import { parseDeliveryChannel } from './delivery-config.ts';
import type { DeliveryChannel } from './delivery-config.ts';
import { clearFailingRun, deliverAlerts } from './delivery.ts';
import { describeError } from './errors.ts';
import { evaluateConditions } from './evaluate-conditions.ts';
import {
  dailyFetch,
  describeAdded,
  describeSuspect,
  updateFetchedPrices,
} from './fetched-prices.ts';
import { hubStatusRecorder } from './hub-status.ts';
import type { HubPass, PassSchedule } from './hub-status.ts';
import { createHub } from './hub.ts';
import { keepInsightReaderGranted } from './insight-reader.ts';
import { recordListening } from './listening.ts';
import { describeLockWait, lockTimeoutOption, migrateWhenFree } from './migration-wait.ts';
import { ntfySender } from './ntfy.ts';
import { FETCH_TIMEOUT_MS } from './price-list.ts';
import type { PriceSource } from './price-list.ts';
import { loadPriceOverrides, syncPrices } from './price-table.ts';
import { BUNDLED_PRICES } from './prices.ts';
import type { PriceEntry } from './prices.ts';
import { projectionNotes, projectTranscripts } from './projection.ts';
import { pruneJobRuns, pruneServiceStops, pruneVitals } from './retention.ts';
import { REFRESH_BUDGET_MS, refreshSessionInsight } from './stored-insight.ts';
import { SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { pairedSystemCount } from './tokens.ts';
import { checkUpstreams } from './upstream-checks.ts';
import { listReleases } from './upstream-releases.ts';
import { HUB_VERSION } from './version.ts';

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
// How often serve looks for upstreams due a check. Each upstream waits
// UPSTREAM_CHECK_INTERVAL_MS between its checks; this only bounds how soon a
// newly recorded one is first checked.
const UPSTREAM_PASS_INTERVAL_MS = 300_000;
// How often serve checks whether the price list is due a fetch. It fetches when
// the process has had no successful fetch in the last day, so a failed fetch
// is tried again this much later (ADR-0024).
const PRICES_INTERVAL_MS = 3_600_000;

// Each timer pass's interval and budget, which the Hub status row records so
// the dashboard can tell a late pass from a slow one. A refresh stops taking
// Sessions after REFRESH_BUDGET_MS and overshoots by at most one statement.
// A prices run's budget, 90 seconds, covers its FETCH_TIMEOUT_MS fetch, the
// lock wait, and the reads and writes of the prices, each statement bounded
// by STATEMENT_TIMEOUT_MS. The other passes have no
// time cap of their own, so their budget is one statement's timeout; the
// dashboard never calls a pass that is still running overdue, and waits two
// intervals after a run finishes (docs/spec.md).
export const PASS_SCHEDULES = {
  conditions: { budgetMs: STATEMENT_TIMEOUT_MS, intervalMs: CONDITIONS_INTERVAL_MS },
  delivery: { budgetMs: STATEMENT_TIMEOUT_MS, intervalMs: DELIVERY_INTERVAL_MS },
  listening: { budgetMs: STATEMENT_TIMEOUT_MS, intervalMs: LISTENING_INTERVAL_MS },
  parse: { budgetMs: STATEMENT_TIMEOUT_MS, intervalMs: PROJECT_INTERVAL_MS },
  prices: { budgetMs: FETCH_TIMEOUT_MS + 2 * STATEMENT_TIMEOUT_MS, intervalMs: PRICES_INTERVAL_MS },
  prune: { budgetMs: STATEMENT_TIMEOUT_MS, intervalMs: PRUNE_INTERVAL_MS },
  refresh: { budgetMs: REFRESH_BUDGET_MS + STATEMENT_TIMEOUT_MS, intervalMs: PROJECT_INTERVAL_MS },
  upstreams: { budgetMs: STATEMENT_TIMEOUT_MS, intervalMs: UPSTREAM_PASS_INTERVAL_MS },
} as const satisfies Record<HubPass, PassSchedule>;

const systemCount = (n: number) => `${String(n)} ${n === 1 ? 'System' : 'Systems'}`;

// `heimdall-hub serve`: brings the database to the latest schema, then accepts
// Reports and transcripts until systemd or a terminal stops it. Its runtime
// lines, fatal ones included, start with their time. It rotates its supervised
// log before writing its first line, then about once a day.
export const serveAction: ActionHandler<typeof serve> = async ({
  host,
  options,
  out,
  provided,
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
    path: servicePaths('hub', host.home).log,
  });
  try {
    // A section that does not parse is fatal; Loom does not look inside them.
    const limits = await Promise.resolve(provided.config.conditions)
      .then(parseConditionLimits)
      .catch((error: unknown) =>
        log.fatal(clean(`Invalid Hub Condition limits: ${describeError(error)}`)),
      );
    const delivery = await Promise.resolve(provided.config.delivery)
      .then(parseDeliveryChannel)
      .catch((error: unknown) =>
        log.fatal(clean(`Invalid Hub delivery settings: ${describeError(error)}`)),
      );
    await serveUntilStopped({
      clean,
      delivery,
      limits,
      lockTimeout: lockTimeoutOption(host.env),
      log,
      options,
      signal,
    });
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
  lockTimeout,
  log,
  options,
  signal,
}: {
  clean: (message: string) => string;
  delivery: DeliveryChannel | undefined;
  limits: ConditionLimits;
  lockTimeout: { lockTimeoutMs?: number };
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
      ...lockTimeout,
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
      onWarn: (message) => {
        void log.warn(clean(message));
      },
      sql,
    });
    const server = listenOrFail({
      fail: (message) => log.fatal(clean(message)),
      fetch: hub.fetch,
      hostname: options.host,
      port: options.port,
    });
    const status = hubStatusRecorder({
      now: Date.now,
      sql,
      warn: (message) => {
        void log.warn(clean(message));
      },
    });
    const priceSource: PriceSource = options['price-source'];
    // A prices pass whose source is off never runs, and its record says so.
    const schedules = {
      ...PASS_SCHEDULES,
      prices:
        priceSource.kind === 'off'
          ? { ...PASS_SCHEDULES.prices, off: true as const }
          : PASS_SCHEDULES.prices,
    };
    const { delivery: deliverySchedule, ...otherSchedules } = schedules;
    // Pruning, judging Conditions, delivering alerts, parsing transcripts, and
    // checking upstreams are routine, so only a failure, a parser switch, or a
    // parser left behind is logged, and the next round tries again. A failed
    // upstream check is stored with its upstream, not logged.
    let stopListening: (() => Promise<void>) | undefined;
    let stopPruning: (() => Promise<void>) | undefined;
    let stopJudging: (() => Promise<void>) | undefined;
    let stopDelivering: (() => Promise<void>) | undefined;
    let stopProjecting: (() => Promise<void>) | undefined;
    let stopRefreshing: (() => Promise<void>) | undefined;
    let stopChecking: (() => Promise<void>) | undefined;
    let stopPricing: (() => Promise<void>) | undefined;
    const outdatedLogged = new Set<string>();
    try {
      // Only a Hub that listens replaces the status row, and before any pass
      // writes to it, since starting clears the previous process's passes.
      await status.start({
        deliveryConfigured: delivery !== undefined,
        passes: delivery === undefined ? otherSchedules : schedules,
        version: HUB_VERSION,
      });
      const paired = await pairedSystemCount(sql);
      await log.info(clean(`Listening on ${server.url.href} for ${systemCount(paired)}.`));
      stopListening = every({
        intervalMs: PASS_SCHEDULES.listening.intervalMs,
        onError: (error) => {
          void log.warn(
            clean(`Could not record that the Hub is listening: ${describeError(error)}`),
          );
        },
        task: () => status.pass('listening', () => recordListening(sql, Date.now())),
      });
      stopPruning = every({
        intervalMs: PASS_SCHEDULES.prune.intervalMs,
        onError: (error) => {
          void log.warn(
            clean(
              `Could not prune old Vitals, Service stops, and job runs: ${describeError(error)}`,
            ),
          );
        },
        task: () =>
          status.pass('prune', async () => {
            const now = Date.now();
            await pruneVitals(sql, now);
            await pruneServiceStops(sql, now);
            await pruneJobRuns(sql, now);
          }),
      });
      stopJudging = every({
        intervalMs: PASS_SCHEDULES.conditions.intervalMs,
        onError: (error) => {
          void log.warn(clean(`Could not judge Conditions: ${describeError(error)}`));
        },
        // Recording first means no judgment runs unless the Hub could record
        // that it listens, so none misses an outage the record would reveal.
        task: () =>
          status.pass('conditions', async () => {
            await recordListening(sql, Date.now());
            await evaluateConditions(sql, Date.now, { ...SYSTEM_CONDITION_THRESHOLDS, ...limits });
          }),
      });
      if (delivery !== undefined) {
        // The server's host is no secret; the topic and token never reach the log.
        await log.info(clean(`Delivering alerts through ${delivery.url.host}.`));
        const send = ntfySender(delivery);
        stopDelivering = every({
          intervalMs: deliverySchedule.intervalMs,
          onError: (error) => {
            void log.warn(clean(`Could not deliver alerts: ${describeError(error)}`));
          },
          task: () =>
            status.pass('delivery', () =>
              deliverAlerts(sql, { dashboard: delivery.dashboard, now: Date.now(), send }),
            ),
        });
      }
      stopProjecting = every({
        intervalMs: PASS_SCHEDULES.parse.intervalMs,
        onError: (error) => {
          void log.warn(clean(`Could not derive Session insight: ${describeError(error)}`));
        },
        task: () =>
          status.pass('parse', async () => {
            const projected = await projectTranscripts(sql);
            for (const { level, text } of projectionNotes(projected, outdatedLogged)) {
              // oxlint-disable-next-line no-await-in-loop -- one line at a time, in order.
              await (level === 'info' ? log.info(clean(text)) : log.warn(clean(text)));
            }
          }),
      });
      stopRefreshing = every({
        intervalMs: PASS_SCHEDULES.refresh.intervalMs,
        onError: (error) => {
          void log.warn(clean(`Could not store Session insight: ${describeError(error)}`));
        },
        task: () => status.pass('refresh', () => refreshSessionInsight(sql)),
      });
      stopChecking = every({
        intervalMs: PASS_SCHEDULES.upstreams.intervalMs,
        onError: (error) => {
          void log.warn(clean(`Could not check upstreams: ${describeError(error)}`));
        },
        task: () =>
          status.pass('upstreams', () =>
            checkUpstreams(sql, {
              list: (upstream) => listReleases(upstream, { fetch, now: Date.now, signal }),
              now: Date.now,
              signal,
            }),
          ),
      });
      if (priceSource.kind === 'list') {
        // Each run that fetches logs the models it adds entries for and the ones
        // it skips as possible unit errors; a failed fetch fails the run.
        const fetchDaily = dailyFetch({
          fetch: async () => {
            const { added, skipped } = await updateFetchedPrices({
              fetch,
              signal,
              source: priceSource.url,
              sql,
            });
            for (const entry of added) {
              // oxlint-disable-next-line no-await-in-loop -- one line at a time, in order.
              await log.info(clean(describeAdded(entry)));
            }
            for (const suspect of skipped.filter(({ kind }) => kind === 'suspect')) {
              // oxlint-disable-next-line no-await-in-loop -- one line at a time, in order.
              await log.warn(clean(describeSuspect(suspect)));
            }
          },
          now: Date.now,
        });
        stopPricing = every({
          intervalMs: PASS_SCHEDULES.prices.intervalMs,
          onError: (error) => {
            void log.warn(clean(`Could not update the fetched prices: ${describeError(error)}`));
          },
          task: () => status.pass('prices', fetchDaily),
        });
      }
      if (!signal.aborted) {
        await once(signal, 'abort');
      }
    } finally {
      // A record, prune, judgment, delivery, parse, refresh, upstream check, or price fetch still running must finish before the database closes.
      await stopListening?.();
      await stopPruning?.();
      await stopJudging?.();
      await stopDelivering?.();
      await stopProjecting?.();
      await stopRefreshing?.();
      await stopChecking?.();
      await stopPricing?.();
      await server.stop();
    }
  } finally {
    await stopGranting?.();
    await sql.close();
  }
};
