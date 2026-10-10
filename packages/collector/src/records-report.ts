import { createHash } from 'node:crypto';

import { MAX_RECORDS_SECTION_BYTES } from '@heimdall/schema';
import type { RecordsSection } from '@heimdall/schema';

import type { Log } from './collector.ts';
import type { PendingRecords, RecordsSource } from './delivery.ts';
import { describeError } from './errors.ts';
import type { RecordStore } from './records.ts';

// How long a delivered set may stand before it is sent again, so a Hub restored
// from backup gets the System's records back (ADR-0011).
export const RECORDS_REFRESH_MS = 60 * 60_000;

// The records section for what the store holds now, and the digest of the whole
// set. A set over `maxBytes` of JSON becomes its size alone, but its digest
// still covers every record, so a change that keeps the size is a change.
const buildSection = (store: RecordStore, maxBytes: number) => {
  const { records, unreadable } = store.read();
  const section = {
    records: records.map(({ kind, name, record }) => ({ kind, name, record })),
    unreadable: unreadable.records.map(({ kind, name }) => ({ kind, name })),
  };
  const json = JSON.stringify(section);
  const bytes = Buffer.byteLength(json);
  const sent: RecordsSection = bytes > maxBytes ? { overBudget: { bytes } } : section;
  return { digest: createHash('sha256').update(json).digest('hex'), section: sent };
};

// Decides which Report carries the Collector's record set (ADR-0011). The set
// is due at start, when another process changes the store's content, and once
// `refreshMs` after the last set the Hub answered. It stays due after a failed
// delivery. The Hub's refusal (422) settles it too, so a set the Hub will not
// take cannot reject every later Report with its Vitals; the refresh retries it.
//
// `store` must be a connection this reporter alone keeps open and never writes
// through, so its `version` moves only when another process commits. A version
// change costs one read, and the set is sent only when its digest differs from
// the last one settled, so recording a run or the same content again sends nothing.
export const createRecordsReporter = ({
  log,
  maxBytes = MAX_RECORDS_SECTION_BYTES,
  now,
  refreshMs = RECORDS_REFRESH_MS,
  store,
}: {
  log: Log;
  maxBytes?: number;
  now: () => number;
  refreshMs?: number;
  store: RecordStore;
}): RecordsSource => {
  let seenVersion: number | undefined;
  let settledDigest: string | undefined;
  let settledAt: number | undefined;
  let due = true;
  let failing = false;

  const settleWith =
    (digest: string): PendingRecords['settle'] =>
    (outcome) => {
      settledDigest = digest;
      settledAt = now();
      due = false;
      if (outcome.kind === 'rejected') {
        log.warn(
          `The Hub rejected a Report carrying the records (${outcome.detail}); they are sent again within ${String(refreshMs / 60_000)} minutes.`,
        );
      }
    };

  const pending = (): PendingRecords | undefined => {
    // The version is read before the set, so a write landing between the two
    // shows as another change on the next call.
    const version = store.version();
    const changed = version !== seenVersion;
    const stale = settledAt !== undefined && now() - settledAt >= refreshMs;
    if (!due && !changed && !stale) {
      return undefined;
    }
    const { digest, section } = buildSection(store, maxBytes);
    seenVersion = version;
    if (!due && !stale && digest === settledDigest) {
      return undefined;
    }
    due = true;
    return { section, settle: settleWith(digest) };
  };

  return {
    // A store that cannot be read costs the records, never the Vitals, and is
    // warned about once until it reads again.
    pending: () => {
      try {
        const next = pending();
        failing = false;
        return next;
      } catch (error) {
        if (!failing) {
          log.warn(`Could not read the records to report: ${describeError(error)}`);
        }
        failing = true;
        return undefined;
      }
    },
  };
};
