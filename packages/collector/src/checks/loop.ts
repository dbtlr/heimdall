import type { ChecksSection } from '@heimdall/schema';
import { every } from '@heimdall/service';

import type { Log } from '../collector.ts';
import { describeError } from '../errors.ts';
import type { RecordStore } from '../records.ts';
import { checkFiles } from './files.ts';
import type { FileMismatch } from './files.ts';

// How often the loop looks for a change to the records.
export const CHECK_INTERVAL_MS = 5000;

// How long the loop trusts the last pass before it checks every file again.
export const RECHECK_MS = 60 * 60_000;

// What the Collector observes against what its provisioner recorded. A pass
// reads the records and builds the whole checks section, so a later check, such
// as a Service's state, adds its own part beside `files` here and reuses the
// timing: a pass runs at start, right after another process changes the
// records, and an hour after the last pass.
//
// It holds a connection to the store of its own, opened on the first tick and
// again on each tick until it opens, so a database that cannot be opened costs
// the checks, never the daemon. The connection only reads, so its `version`
// moves only when another process commits. `latest` answers the section the
// last pass built, the same object until the next pass, or undefined before the
// first. `tick` never throws; `signal` cuts a pass short, and a cut pass
// replaces nothing.
export const createChecks = ({
  log,
  now,
  open,
  recheckMs = RECHECK_MS,
  signal,
}: {
  log: Log;
  now: () => number;
  open: () => Promise<RecordStore>;
  recheckMs?: number;
  signal?: AbortSignal;
}) => {
  let store: RecordStore | undefined;
  let seenVersion: number | undefined;
  let passedAt: number | undefined;
  let files: FileMismatch[] = [];
  let latest: ChecksSection | undefined;
  let failing = false;

  const pass = async (held: RecordStore) => {
    // The version is read before the records, so a write landing between the
    // two shows as another change on the next tick.
    const version = held.version();
    const due =
      latest === undefined ||
      version !== seenVersion ||
      (passedAt !== undefined && now() - passedAt >= recheckMs);
    if (!due) {
      return;
    }
    const startedAt = now();
    const mismatched = await checkFiles({
      now: startedAt,
      previous: files,
      records: held.readRecords().records,
      ...(signal === undefined ? {} : { signal }),
    });
    if (mismatched === undefined) {
      return;
    }
    seenVersion = version;
    passedAt = startedAt;
    files = mismatched;
    latest = { files: mismatched };
  };

  return {
    close: () => {
      store?.close();
      store = undefined;
      // A store opened again may carry a version this one never saw.
      seenVersion = undefined;
    },
    latest: () => latest,
    tick: async () => {
      try {
        store ??= await open();
        await pass(store);
        failing = false;
      } catch (error) {
        if (!failing) {
          log.warn(`Could not read the records to check: ${describeError(error)}`);
        }
        failing = true;
      }
    },
  };
};

// Runs the checks beside the Vitals loop, every interval after the last tick
// finishes. The returned function stops the loop, waits for a tick in flight,
// and closes the store.
export const startChecks = ({
  intervalMs = CHECK_INTERVAL_MS,
  ...options
}: Parameters<typeof createChecks>[0] & { intervalMs?: number }) => {
  const checks = createChecks(options);
  const stop = every({
    intervalMs,
    onError: (error) => options.log.warn(`Checking recorded files failed: ${describeError(error)}`),
    task: checks.tick,
  });
  return {
    latest: checks.latest,
    stop: async () => {
      await stop();
      checks.close();
    },
  };
};
