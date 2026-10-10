import { z } from 'zod';

import { RECORD_NAME, REPORTED_RECORD_SCHEMAS, REPORTED_RUN_SCHEMA } from './records.ts';
import type { RecordKind, RecordOf } from './records.ts';
import { bytes } from './values.ts';

// The most bytes of JSON a Collector's record set may take in a Report. A set
// over it travels as a marker, so it never makes a Report too large for the
// Hub, which would reject the Vitals with it.
export const MAX_RECORDS_SECTION_BYTES = 8 * 1024 * 1024;

// A kind is any short word, so a kind only a newer Collector knows does not
// reject a Report (ADR-0004).
const kindWord = z.string().min(1).max(64);

// A record the Collector could not read from its own state, by kind and name.
const RecordRefSchema = z.object({ kind: kindWord, name: z.string().regex(RECORD_NAME) });

// A record as the provisioner recorded it, which the Hub reads by its kind.
const SentRecordSchema = RecordRefSchema.extend({ record: z.record(z.string(), z.unknown()) });

// A Report's records section: the whole set of records the Collector holds,
// with each record as the provisioner recorded it, and the rows it could not
// read. A Collector sends it when its set changes, when it starts, and hourly;
// the Hub replaces the System's mirror with it (ADR-0011). A set over budget is
// sent as its size alone.
export const RecordsSectionSchema = z.union([
  z.object({
    records: z.array(SentRecordSchema),
    unreadable: z.array(RecordRefSchema),
  }),
  z.object({ overBudget: z.object({ bytes }) }),
]);

export type RecordsSection = z.infer<typeof RecordsSectionSchema>;
export type RecordRef = z.infer<typeof RecordRefSchema>;
export type SentRecord = z.infer<typeof SentRecordSchema>;

// A record of a kind the Hub knows, by kind and name.
export type MirroredRecord = {
  [K in RecordKind]: { kind: K; name: string; record: RecordOf<K> };
}[RecordKind];

// A System's records as the Hub mirrors them, or the size of a set it could
// not be sent.
export type MirroredRecords =
  | { records: MirroredRecord[]; unreadable: RecordRef[] }
  | { overBudget: { bytes: number } };

// The record as `schema` reads it, or undefined when it does not fit.
const parse = <S extends z.ZodType>(schema: S, record: unknown) => {
  const result = schema.safeParse(record);
  return result.success ? result.data : undefined;
};

// One record the Collector sent, or undefined when this Hub cannot read it.
const mirrorRecord = ({ kind, name, record }: SentRecord): MirroredRecord | undefined => {
  if (record.name !== name) {
    return undefined;
  }
  const schemas = REPORTED_RECORD_SCHEMAS;
  switch (kind) {
    case 'application': {
      const parsed = parse(schemas.application, record);
      return parsed && { kind, name, record: parsed };
    }
    case 'files': {
      const parsed = parse(schemas.files, record);
      return parsed && { kind, name, record: parsed };
    }
    case 'job': {
      const parsed = parse(schemas.job, record);
      return parsed && { kind, name, record: parsed };
    }
    case 'service': {
      const parsed = parse(schemas.service, record);
      return parsed && { kind, name, record: parsed };
    }
    default: {
      return undefined;
    }
  }
};

// The records a Hub mirrors from a records section. A record whose kind or
// shape this Hub does not know, or whose name differs from the one it was sent
// under, is still on the System, so it counts as unreadable rather than
// missing. A record sent twice under one kind and name keeps the last, and one
// that is mirrored is not also listed as unreadable.
export const mirrorRecords = (section: RecordsSection): MirroredRecords => {
  if ('overBudget' in section) {
    return { overBudget: section.overBudget };
  }
  const records = new Map<string, MirroredRecord>();
  const unreadable: RecordRef[] = [...section.unreadable];
  for (const entry of section.records) {
    const mirrored = mirrorRecord(entry);
    if (mirrored === undefined) {
      unreadable.push({ kind: entry.kind, name: entry.name });
    } else {
      records.set(JSON.stringify([entry.kind, entry.name]), mirrored);
    }
  }
  return {
    records: [...records.values()],
    unreadable: unreadable.filter((ref) => !records.has(JSON.stringify([ref.kind, ref.name]))),
  };
};

// A mirrored record of kind `kind`, as `GET /api/v1/records` returns it.
const mirroredOf = <K extends RecordKind>(kind: K) =>
  z.object({ kind: z.literal(kind), name: z.string(), record: REPORTED_RECORD_SCHEMAS[kind] });

// A mirrored record, read by its kind.
const MirroredRecordSchema = z.discriminatedUnion('kind', [
  mirroredOf('application'),
  mirroredOf('files'),
  mirroredOf('job'),
  mirroredOf('service'),
]);

// A time as UTC ISO 8601 text from `Date.toISOString`. Not checked as a
// datetime, since a far-future `sentAt` prints with an expanded year, and one
// System's time must not make the read fail for the rest.
const isoTime = z.string();

// One job's latest runs, as the read returns them.
const JobRunsReadSchema = z.object({
  job: z.string(),
  latestRun: REPORTED_RUN_SCHEMA,
  latestSuccess: REPORTED_RUN_SCHEMA.nullable(),
});

const jobNames = z.array(z.string());

// A System's latest runs as the read returns them: the jobs, the size of runs
// too large to send, or null until a Report carries them, which a Collector
// older than the runs section never sends.
const RunsReadSchema = z.union([
  z.object({
    jobs: z.array(JobRunsReadSchema),
    receivedAt: isoTime,
    sentAt: isoTime,
    unreadable: jobNames,
  }),
  z.object({ overBudget: z.object({ bytes }), receivedAt: isoTime, sentAt: isoTime }),
  z.null(),
]);

// What every System's entry carries beside its records: its latest runs, and
// its time zone, null until a Report names one.
const systemFields = { runs: RunsReadSchema, system: z.string(), timeZone: z.string().nullable() };

const SetReadSchema = z.object({
  ...systemFields,
  receivedAt: isoTime,
  records: z.array(MirroredRecordSchema),
  sentAt: isoTime,
  unreadable: z.array(RecordRefSchema),
});

const OverBudgetReadSchema = z.object({
  ...systemFields,
  overBudget: z.object({ bytes }),
  receivedAt: isoTime,
  sentAt: isoTime,
});

const NoSetReadSchema = z.object({ ...systemFields, records: z.null() });

// The answer of `GET /api/v1/records`: one entry per System, sorted by name.
// An entry holds the set the System last sent, the size of a set too large to
// send, or `null` records while no Report has carried a set, which is not the
// same as holding none. Records sort by kind, then name, and jobs' latest runs
// by job. Every entry also carries the System's time zone and latest runs.
export const RecordsReadSchema = z.object({
  systems: z.array(z.union([SetReadSchema, OverBudgetReadSchema, NoSetReadSchema])),
});

export type RecordsRead = z.infer<typeof RecordsReadSchema>;
