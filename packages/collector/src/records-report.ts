import { createHash } from 'node:crypto';

import { MAX_RECORDS_SECTION_BYTES, RECORD_NAME } from '@heimdall/schema';
import type { RecordsSection } from '@heimdall/schema';

import type { Log } from './collector.ts';
import type { PendingRecords, RecordsSource } from './delivery.ts';
import { describeError } from './errors.ts';
import type { RecordStore } from './records.ts';

// How long a delivered set may stand before it is sent again, so a Hub restored
// from backup gets the System's records back (ADR-0011).
export const RECORDS_REFRESH_MS = 60 * 60_000;

const MAX_KIND_LENGTH = 64;
const MAX_LISTED_ROWS = 5;

// Whether the records section can carry a row under this kind and name. The Hub
// refuses a whole Report, Vitals with it, for one entry it cannot take.
const carriable = ({ kind, name }: { kind: string; name: string }) =>
  kind.length >= 1 && kind.length <= MAX_KIND_LENGTH && RECORD_NAME.test(name);

const describeRows = (rows: { kind: string; name: string }[]) => {
  const listed = rows
    .slice(0, MAX_LISTED_ROWS)
    .map(({ kind, name }) => JSON.stringify([kind, name]));
  const more = rows.length - listed.length;
  return more > 0 ? `${listed.join(', ')} and ${String(more)} more` : listed.join(', ');
};

// The records section for what the store holds now, and the digest of the
// section as sent. A row under a kind or name the section cannot carry is left
// out and warned about, and a record stored under a name other than its own is
// unreadable as stored. A set over `maxBytes` of JSON becomes its size alone, so
// its digest covers that size, and a change that keeps the size is not sent.
const buildSection = (store: RecordStore, maxBytes: number, log: Log) => {
  const { records, unreadable } = store.read();
  const named = records.filter(({ name, record }) => record.name === name);
  const section = {
    records: named.map(({ kind, name, record }) => ({ kind, name, record })),
    unreadable: [
      ...unreadable.records,
      ...records.filter(({ name, record }) => record.name !== name),
    ].map(({ kind, name }) => ({ kind, name })),
  };
  const refused = [...section.records, ...section.unreadable].filter((row) => !carriable(row));
  if (refused.length > 0) {
    log.warn(
      `Left out of the records report, since the Hub cannot take their kind or name: ${describeRows(refused)}.`,
    );
  }
  const carried = {
    records: section.records.filter(carriable),
    unreadable: section.unreadable.filter(carriable),
  };
  const bytes = Buffer.byteLength(JSON.stringify(carried));
  const sent: RecordsSection = bytes > maxBytes ? { overBudget: { bytes } } : carried;
  return {
    digest: createHash('sha256').update(JSON.stringify(sent)).digest('hex'),
    section: sent,
  };
};

// Decides which Report carries the Collector's record set (ADR-0011). The set
// is due at start, when another process changes the store's content, and once
// `refreshMs` after the last set the Hub answered. It stays due after a failed
// delivery. The Hub's refusal (422) settles it too, so a set the Hub will not
// take cannot reject every later Report with its Vitals; the refresh retries it.
//
// The store is opened on the first call that needs it, and again on each call
// until it opens, so a database that cannot be opened costs the records, never
// the daemon. The connection is one this reporter alone keeps open and never
// writes through, so its `version` moves only when another process commits. A
// version change costs one read, and the set is sent only when its digest
// differs from the last one settled, so recording a run or the same content
// again sends nothing.
export const createRecordsReporter = ({
  log,
  maxBytes = MAX_RECORDS_SECTION_BYTES,
  now,
  open,
  refreshMs = RECORDS_REFRESH_MS,
}: {
  log: Log;
  maxBytes?: number;
  now: () => number;
  open: () => Promise<RecordStore>;
  refreshMs?: number;
}): RecordsSource & { close: () => void } => {
  let store: RecordStore | undefined;
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

  const pending = async (): Promise<PendingRecords | undefined> => {
    store ??= await open();
    // The version is read before the set, so a write landing between the two
    // shows as another change on the next call.
    const version = store.version();
    const changed = version !== seenVersion;
    const stale = settledAt !== undefined && now() - settledAt >= refreshMs;
    if (!due && !changed && !stale) {
      return undefined;
    }
    const { digest, section } = buildSection(store, maxBytes, log);
    seenVersion = version;
    if (!due && !stale && digest === settledDigest) {
      return undefined;
    }
    due = true;
    return { section, settle: settleWith(digest) };
  };

  return {
    close: () => {
      store?.close();
      store = undefined;
    },
    // A store that cannot be opened or read costs the records, never the
    // Vitals, and is warned about once until it works again.
    pending: async () => {
      try {
        const next = await pending();
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
