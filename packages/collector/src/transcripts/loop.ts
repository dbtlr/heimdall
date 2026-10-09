import type { TranscriptsSection } from '@heimdall/schema';
import { every } from '@heimdall/service';

import { MAX_BACKOFF_MS } from '../collector.ts';
import type { Log } from '../collector.ts';
import { describeError } from '../errors.ts';
import type { DrainResult } from './capture.ts';

export const SCAN_INTERVAL_MS = 60_000;

const DAY_MS = 86_400_000;

type Capture = {
  drain: () => Promise<DrainResult>;
  scan: () => Promise<void>;
  section: () => TranscriptsSection;
};

// Runs `capture` beside the Vitals loop: every interval it scans the sources,
// so content reaches the spool even while the Hub is down, then drains the
// spool. After a failed drain, drains back off exponentially up to
// `maxBackoffMs`, as Report pushes do, while scans carry on. It warns once
// when the spool holds content spooled more than a day ago. The returned
// function stops the loop and waits for a tick in flight.
export const startCapture = ({
  capture,
  intervalMs = SCAN_INTERVAL_MS,
  log,
  maxBackoffMs = MAX_BACKOFF_MS,
  now,
}: {
  capture: Capture;
  intervalMs?: number;
  log: Log;
  maxBackoffMs?: number;
  now: () => number;
}): (() => Promise<void>) => {
  let retryAt = 0;
  let backoffMs = intervalMs;
  let outage: string | undefined;
  let scanProblem: string | undefined;
  let stale = false;

  const drain = async () => {
    const result = await capture.drain();
    if (result.kind === 'failed') {
      if (outage === undefined) {
        log.warn(`Uploading transcripts failed (${result.reason}); they stay spooled.`);
      }
      outage = result.reason;
      retryAt = performance.now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      return;
    }
    if (outage !== undefined) {
      log.info('Uploading transcripts works again.');
    }
    outage = undefined;
    retryAt = 0;
    backoffMs = intervalMs;
  };

  const warnIfStale = () => {
    const { oldestAt } = capture.section().spool;
    const isStale = oldestAt !== null && now() - oldestAt > DAY_MS;
    if (isStale && !stale) {
      log.warn(
        'The transcript spool holds content the Hub has not acknowledged for more than a day.',
      );
    }
    stale = isStale;
  };

  const tick = async () => {
    try {
      await capture.scan();
      scanProblem = undefined;
    } catch (error) {
      const problem = describeError(error);
      if (problem !== scanProblem) {
        log.warn(`Could not scan for transcripts: ${problem}`);
      }
      scanProblem = problem;
    }
    if (performance.now() >= retryAt) {
      await drain();
    }
    warnIfStale();
  };

  return every({
    intervalMs,
    onError: (error) => log.warn(`Transcript capture failed: ${describeError(error)}`),
    task: tick,
  });
};
