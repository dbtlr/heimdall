import { createHash } from 'node:crypto';

import {
  MAX_CHECKS_PART_BYTES,
  MAX_RECORDS_SECTION_BYTES,
  MAX_RUNS_SECTION_BYTES,
  RECORD_NAME,
} from '@heimdall/schema';
import type { ChecksSection, RecordsSection, RunsSection } from '@heimdall/schema';

import type { CheckParts, CheckPartsSource } from './checks/parts.ts';
import type { Log } from './collector.ts';
import type { PendingSection, SectionsSource } from './delivery.ts';
import { describeError } from './errors.ts';
import type { RecordStore } from './records.ts';

// How long a delivered section may stand before it is sent again, so a Hub
// restored from backup gets the System's records, runs, and checks back (ADR-0011).
export const SECTIONS_REFRESH_MS = 60 * 60_000;

const MAX_KIND_LENGTH = 64;
const MAX_LISTED_ROWS = 5;

// Whether the records section can carry a row under this kind and name. The Hub
// refuses a whole Report, Vitals with it, for one entry it cannot take.
const carriable = ({ kind, name }: { kind: string; name: string }) =>
  kind.length >= 1 && kind.length <= MAX_KIND_LENGTH && RECORD_NAME.test(name);

export const describeRows = (rows: string[]) => {
  const listed = rows.slice(0, MAX_LISTED_ROWS);
  const more = rows.length - listed.length;
  return more > 0 ? `${listed.join(', ')} and ${String(more)} more` : listed.join(', ');
};

// The digest that says whether a section as sent differs from the last one settled.
const digestOf = (section: object) =>
  createHash('sha256').update(JSON.stringify(section)).digest('hex');

// A section as sent, with its digest. A section over `maxBytes` of JSON becomes
// its size alone, so its digest covers that size, and a change that keeps the
// size is not sent.
const digested = <Section extends object>(
  carried: Section,
  maxBytes: number,
): { digest: string; section: Section | { overBudget: { bytes: number } } } => {
  const bytes = Buffer.byteLength(JSON.stringify(carried));
  const section = bytes > maxBytes ? { overBudget: { bytes } } : carried;
  return { digest: digestOf(section), section };
};

// The size of a checks part that is over `maxBytes` of JSON, or undefined when
// it is within the budget or the loops built none.
const overBudgetOf = (part: object, maxBytes: number) => {
  if (Object.keys(part).length === 0) {
    return undefined;
  }
  const bytes = Buffer.byteLength(JSON.stringify(part));
  return bytes > maxBytes ? { bytes } : undefined;
};

// The checks section for the parts the loops built, and its digest. Each part
// has its own budget of `maxBytes` of JSON, and one over it becomes its size
// alone under `overBudget`, so a part that is too large never stops the others
// from being sent. The files part is `fileRecords` with `files`.
const buildChecks = (parts: CheckParts, maxBytes: number) => {
  const filesPart = {
    ...(parts.fileRecords === undefined ? {} : { fileRecords: parts.fileRecords }),
    ...(parts.files === undefined ? {} : { files: parts.files }),
  };
  const servicesPart = parts.services === undefined ? {} : { services: parts.services };
  const files = overBudgetOf(filesPart, maxBytes);
  const services = overBudgetOf(servicesPart, maxBytes);
  const section: ChecksSection = {
    ...(files === undefined ? filesPart : {}),
    ...(services === undefined ? servicesPart : {}),
    ...(files === undefined && services === undefined
      ? {}
      : {
          overBudget: {
            ...(files === undefined ? {} : { files }),
            ...(services === undefined ? {} : { services }),
          },
        }),
  };
  return { digest: digestOf(section), section };
};

// The records section for what the store holds now, and the digest of the
// section as sent. A row under a kind or name the section cannot carry is left
// out and warned about, and a record stored under a name other than its own is
// unreadable as stored.
const buildRecords = (store: RecordStore, maxBytes: number, log: Log) => {
  const { records, unreadable } = store.readRecords();
  const named = records.filter(({ name, record }) => record.name === name);
  const section = {
    records: named.map(({ kind, name, record }) => ({ kind, name, record })),
    unreadable: [...unreadable, ...records.filter(({ name, record }) => record.name !== name)].map(
      ({ kind, name }) => ({ kind, name }),
    ),
  };
  const refused = [...section.records, ...section.unreadable].filter((row) => !carriable(row));
  if (refused.length > 0) {
    log.warn(
      `Left out of the records report, since the Hub cannot take their kind or name: ${describeRows(refused.map(({ kind, name }) => JSON.stringify([kind, name])))}.`,
    );
  }
  return digested<RecordsSection>(
    {
      records: section.records.filter(carriable),
      unreadable: section.unreadable.filter(carriable),
    },
    maxBytes,
  );
};

// The runs section for what the store holds now, and the digest of the section
// as sent. A job whose name the section cannot carry is left out and warned
// about.
const buildRuns = (store: RecordStore, maxBytes: number, log: Log) => {
  const { jobs, unreadable } = store.latestRuns();
  const refused = [...jobs.map(({ job }) => job), ...unreadable].filter(
    (job) => !RECORD_NAME.test(job),
  );
  if (refused.length > 0) {
    log.warn(
      `Left out of the runs report, since the Hub cannot take their job names: ${describeRows(refused.map((job) => JSON.stringify(job)))}.`,
    );
  }
  return digested<RunsSection>(
    {
      jobs: jobs.filter(({ job }) => RECORD_NAME.test(job)),
      unreadable: unreadable.filter((job) => RECORD_NAME.test(job)),
    },
    maxBytes,
  );
};

// Decides when one section is due: at start, when `changed` says the store's
// content may differ and the section's digest does, and once `refreshMs` after
// the last time the Hub answered a Report carrying it. It stays due after a
// failed delivery. The Hub's refusal (422) settles it too, so a section the Hub
// will not take cannot reject every later Report with its Vitals; the refresh
// retries it.
const createSectionState = <Section>({
  build,
  label,
  log,
  now,
  refreshMs,
}: {
  build: (store: RecordStore) => { digest: string; section: Section };
  label: string;
  log: Log;
  now: () => number;
  refreshMs: number;
}) => {
  let settledDigest: string | undefined;
  let settledAt: number | undefined;
  let due = true;

  const settleWith =
    (digest: string): PendingSection<Section>['settle'] =>
    (outcome) => {
      settledDigest = digest;
      settledAt = now();
      due = false;
      if (outcome.kind === 'rejected') {
        log.warn(
          `The Hub rejected a Report carrying the ${label} (${outcome.detail}); they are sent again within ${String(refreshMs / 60_000)} minutes.`,
        );
      }
    };

  return {
    // The section to send now, or undefined when it need not be sent. Nothing is
    // built unless the section is due, stale, or the store changed.
    pending: (store: RecordStore, changed: boolean): PendingSection<Section> | undefined => {
      const stale = settledAt !== undefined && now() - settledAt >= refreshMs;
      if (!due && !changed && !stale) {
        return undefined;
      }
      const { digest, section } = build(store);
      if (!due && !stale && digest === settledDigest) {
        return undefined;
      }
      due = true;
      return { section, settle: settleWith(digest) };
    },
  };
};

// What the checks section is built from: the parts the Collector's loops built
// last, or undefined while none has finished a pass.
export type ChecksSource = CheckPartsSource;

// Decides which Report carries the Collector's record set (ADR-0011), its
// jobs' latest runs, and its checks. Each section is due at start, when its
// content may have changed and its digest differs from the last one settled,
// and once `refreshMs` after the last one the Hub answered. The store's content
// may have changed when another process commits; the checks' when `checks`
// answers another section than before, which is none until the loop's first
// pass. The sections settle apart, so recording a run sends the runs and not the
// record set, and changing a record sends the set, and the runs only if they
// changed too.
//
// The store is opened on the first call that needs it, and again on each call
// until it opens, so a database that cannot be opened costs the sections, never
// the daemon. The connection is one this reporter alone keeps open, and the
// only write it makes is opening the store, which may create the run indexes
// once, so its `version` moves only when another process commits. A
// version change costs one read of the records and one query for the latest
// runs, never a parse of every run, and a section is sent only when its digest
// differs from the last one settled, so recording the same content again sends
// nothing.
export const createSectionsReporter = ({
  checks,
  log,
  maxChecksBytes = MAX_CHECKS_PART_BYTES,
  maxRecordsBytes = MAX_RECORDS_SECTION_BYTES,
  maxRunsBytes = MAX_RUNS_SECTION_BYTES,
  now,
  open,
  refreshMs = SECTIONS_REFRESH_MS,
}: {
  checks: ChecksSource;
  log: Log;
  maxChecksBytes?: number;
  maxRecordsBytes?: number;
  maxRunsBytes?: number;
  now: () => number;
  open: () => Promise<RecordStore>;
  refreshMs?: number;
}): SectionsSource & { close: () => void } => {
  let store: RecordStore | undefined;
  let seenVersion: number | undefined;
  let seenChecks: CheckParts | undefined;
  let failing = false;

  const records = createSectionState<RecordsSection>({
    build: (held) => buildRecords(held, maxRecordsBytes, log),
    label: 'records',
    log,
    now,
    refreshMs,
  });
  const runs = createSectionState<RunsSection>({
    build: (held) => buildRuns(held, maxRunsBytes, log),
    label: 'runs',
    log,
    now,
    refreshMs,
  });

  const checked = createSectionState<ChecksSection>({
    // Asked for only once the checks have a section.
    build: () => buildChecks(checks.latest() ?? {}, maxChecksBytes),
    label: 'checks',
    log,
    now,
    refreshMs,
  });

  const pending = async () => {
    store ??= await open();
    // The version is read before the sections, so a write landing between the
    // two shows as another change on the next call.
    const version = store.version();
    const changed = version !== seenVersion;
    const latestChecks = checks.latest();
    const due = {
      checks:
        latestChecks === undefined
          ? undefined
          : checked.pending(store, latestChecks !== seenChecks),
      records: records.pending(store, changed),
      runs: runs.pending(store, changed),
    };
    seenVersion = version;
    seenChecks = latestChecks;
    return {
      ...(due.checks === undefined ? {} : { checks: due.checks }),
      ...(due.records === undefined ? {} : { records: due.records }),
      ...(due.runs === undefined ? {} : { runs: due.runs }),
    };
  };

  return {
    close: () => {
      store?.close();
      store = undefined;
      // A store opened again may carry a version this one never saw.
      seenVersion = undefined;
      seenChecks = undefined;
    },
    // A store that cannot be opened or read costs the sections, never the
    // Vitals, and is warned about once until it works again.
    pending: async () => {
      try {
        const next = await pending();
        failing = false;
        return next;
      } catch (error) {
        if (!failing) {
          log.warn(`Could not read the records and runs to report: ${describeError(error)}`);
        }
        failing = true;
        return {};
      }
    },
  };
};
