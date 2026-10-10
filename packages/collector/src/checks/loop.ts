import { filesRecordDigest, RECORD_NAME } from '@heimdall/schema';
import type { ChecksSection } from '@heimdall/schema';
import { every } from '@heimdall/service';

import type { Log } from '../collector.ts';
import { describeError } from '../errors.ts';
import type { RecordStore, StoredRecord } from '../records.ts';
import { describeRows } from '../sections-report.ts';
import { checkFiles } from './files.ts';
import type { FileMismatch, FilesRecordToCheck } from './files.ts';

// How often the loop looks for a change to the records.
export const CHECK_INTERVAL_MS = 5000;

// How long the loop trusts the last pass before it hashes every file again.
export const RECHECK_MS = 60 * 60_000;

// The files records among the stored ones, each with its digest. A row stored
// under a name other than its own, or under one the checks section cannot
// carry, is left out and warned about: the Hub refuses a whole Report, Vitals
// with it, for one entry it cannot take.
const filesRecordsOf = async (stored: readonly StoredRecord[]) => {
  const refused: string[] = [];
  const named = stored.flatMap(({ kind, name, record }) => {
    if (kind !== 'files' || !('files' in record)) {
      return [];
    }
    if (record.name === name && RECORD_NAME.test(name)) {
      return [{ files: record.files, name, record }];
    }
    refused.push(JSON.stringify(name));
    return [];
  });
  const records: FilesRecordToCheck[] = await Promise.all(
    named.map(async ({ files, name, record }) => ({
      digest: await filesRecordDigest(record),
      files,
      name,
    })),
  );
  return { records, refused };
};

// What the Collector observes against what its provisioner recorded: a pass
// hashes the files of every `files` record and builds the whole checks section.
// A pass runs at start, when the `files` records change, and an hour after the
// last pass. Another process committing to the store moves its version, which
// is only the cheap sign that the records may have changed: a pass runs only
// when the digests of the `files` records differ, so recording a run or the same
// record again hashes nothing before the hour. Checks that need their own
// cadence, such as a Service's state each minute, must not wait behind this
// loop's hashing, so they run in a loop of their own and add a part to the
// section.
//
// It holds a connection to the store of its own, opened on the first tick and
// again on each tick until it opens, so a database that cannot be opened costs
// the checks, never the daemon. The connection only reads, so its `version`
// moves only when another process commits. `latest` answers the section the
// last pass built, the same object until the next pass, or undefined before the
// first. `tick` never throws; `signal` cuts a pass short, and a cut pass
// replaces nothing. A file's `since` is kept while the Collector runs and starts
// over when it restarts.
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
  let passedDigests: string | undefined;
  let mismatches: FileMismatch[] = [];
  let latest: ChecksSection | undefined;
  let warnedAbout = '';
  let failing = false;

  const pass = async (held: RecordStore) => {
    // The version is read before the records, so a write landing between the
    // two shows as another change on the next tick.
    const version = held.version();
    const hourlyDue = passedAt !== undefined && now() - passedAt >= recheckMs;
    if (latest !== undefined && version === seenVersion && !hourlyDue) {
      return;
    }
    const { records, refused } = await filesRecordsOf(held.readRecords().records);
    const warning = refused.join(', ');
    if (refused.length > 0 && warning !== warnedAbout) {
      log.warn(
        `Left out of the file checks, since the Hub cannot take their names: ${describeRows(refused)}.`,
      );
    }
    warnedAbout = warning;
    const digests = JSON.stringify(records.map(({ digest, name }) => [name, digest]));
    if (latest !== undefined && digests === passedDigests && !hourlyDue) {
      seenVersion = version;
      return;
    }
    const startedAt = now();
    const found = await checkFiles({
      now: startedAt,
      previous: mismatches,
      records,
      ...(signal === undefined ? {} : { signal }),
    });
    if (found === undefined) {
      return;
    }
    seenVersion = version;
    passedAt = startedAt;
    passedDigests = digests;
    mismatches = found.mismatches;
    latest = { fileRecords: found.fileRecords, files: found.mismatches };
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
