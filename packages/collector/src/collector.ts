import { setTimeout } from 'node:timers/promises';

import type { Report, TranscriptsSection } from '@heimdall/schema';

import { flushQueue } from './delivery.ts';
import type { Delivery, FlushResult, RecordsSource, ReportIdentity } from './delivery.ts';
import { describeError } from './errors.ts';
import type { SampleQueue } from './queue.ts';
import type { Sampler } from './vitals/sampler.ts';

export const SAMPLE_INTERVAL_MS = 15_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

export type Log = { info: (message: string) => unknown; warn: (message: string) => unknown };

// Resolves after `ms`, or as soon as `signal` aborts.
const pause = async (ms: number, signal: AbortSignal) => {
  await setTimeout(Math.max(0, ms), undefined, { signal }).catch(() => undefined);
};

const reportRejections = (result: FlushResult, log: Log) => {
  for (const { detail, samples } of result.rejected) {
    log.warn(
      `The Hub rejected a Report of ${String(samples)} samples, which are dropped: ${detail}`,
    );
  }
};

// The Collector's work until `signal` aborts: every interval take a sample,
// queue it, and push the backlog to the Hub. After a failed push, retries back
// off exponentially up to `maxBackoffMs` while sampling carries on.
export const runCollector = async ({
  identity,
  intervalMs = SAMPLE_INTERVAL_MS,
  log,
  maxBackoffMs = MAX_BACKOFF_MS,
  queue,
  records,
  sampler,
  send,
  signal,
  transcripts,
}: {
  identity: ReportIdentity;
  intervalMs?: number;
  log: Log;
  maxBackoffMs?: number;
  queue: SampleQueue;
  records: RecordsSource;
  sampler: Sampler;
  send: (report: Report) => Promise<Delivery>;
  signal: AbortSignal;
  transcripts: () => TranscriptsSection;
}): Promise<void> => {
  let nextSampleAt = performance.now() + intervalMs;
  let retryAt = 0;
  let backoffMs = intervalMs;
  let outage: string | undefined;

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- the loop is the schedule.
    await pause(nextSampleAt - performance.now(), signal);
    if (signal.aborted) {
      return;
    }
    // A late wake, after a slow push or a laptop sleep, waits a full interval
    // from now, so no two samples land close together.
    nextSampleAt = Math.max(nextSampleAt, performance.now()) + intervalMs;
    try {
      // oxlint-disable-next-line no-await-in-loop -- one sample per interval.
      queue.append(await sampler.sample());
    } catch (error) {
      // One failed reading costs one sample, not the Collector.
      log.warn(`Could not sample this System: ${describeError(error)}`);
    }
    if (performance.now() < retryAt) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- one push at a time.
    const result = await flushQueue({
      identity,
      now: Date.now,
      queue,
      records,
      send,
      transcripts,
    }).catch((error: unknown): FlushResult => ({
      delivered: 0,
      kind: 'failed',
      reason: describeError(error),
      rejected: [],
    }));
    reportRejections(result, log);
    if (result.kind === 'failed') {
      if (outage === undefined) {
        log.warn(`Pushing to the Hub failed (${result.reason}); samples stay queued.`);
      }
      outage = result.reason;
      retryAt = performance.now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    } else {
      if (outage !== undefined) {
        log.info(
          `Pushing to the Hub works again; delivered ${String(result.delivered)} queued samples.`,
        );
      }
      outage = undefined;
      retryAt = 0;
      backoffMs = intervalMs;
    }
  }
};
