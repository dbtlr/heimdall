import { z } from 'zod';

import { bytes } from './values.ts';

// What a provisioner tells a Collector it installed (ADR-0011). A provisioner
// pipes one record to `heimdall-collector record <kind>`; the Collector checks
// it against these schemas and refuses a field they do not name, so the
// provisioner sees the refusal. The Hub reads the same records from Reports
// with schemas that drop unknown fields instead.

// The kinds of record a provisioner makes by name. A job's runs are recorded
// separately, keyed by job and start time.
export const RECORD_KINDS = ['application', 'service', 'job', 'files'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

// The name of a record, of a job a run belongs to, and the name `forget` takes.
export const RECORD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const name = z.string().regex(RECORD_NAME);

// Free text for a person to read: no control characters, so it cannot rewrite a
// terminal or break a line, and well-formed Unicode, so PostgreSQL can store it
// in a Report.
const text = (maxLength = 256) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .regex(/^\P{Cc}+$/u, { message: 'must not contain control characters' })
    .refine((value) => value.isWellFormed(), { message: 'must be well-formed Unicode' });

const MAX_PORT = 65_535;

const port = z.int().min(1).max(MAX_PORT);

// A health URL the Collector may request: plain HTTP to a loopback address
// with an explicit port. Nothing may follow the port but a path of printable
// ASCII, so no user part can hide another host, and `localhost` is refused
// because a resolver may send it elsewhere.
const loopbackUrl = z
  .string()
  .max(512)
  .regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}(?:\/[!-~]*)?$/u)
  .refine((url) => Number(/^http:\/\/[^/]+:([0-9]+)/u.exec(url)?.[1]) <= MAX_PORT, {
    message: 'health URL port out of range',
  });

type CalendarEntry = {
  day?: number | undefined;
  hour?: number | undefined;
  minute?: number | undefined;
  month?: number | undefined;
  weekday?: number | undefined;
};

// The entry as a string that is equal for entries that match the same times.
const entryKey = ({ day, hour, minute, month, weekday }: CalendarEntry) =>
  JSON.stringify([minute, hour, day, weekday === 7 ? 0 : weekday, month]);

const MAX_SCHEDULE_ENTRIES = 100;

const MAX_PATH_BYTES = 4096;
const MAX_FILES = 10_000;

// Whether `path` names a file in one way: no empty, `.`, or `..` segment, which
// also rules out a trailing slash and `/` alone.
const isNormalized = (path: string) =>
  path
    .split('/')
    .every(
      (segment, index) => index === 0 || (segment !== '' && segment !== '.' && segment !== '..'),
    );

const absolutePath = z
  .string()
  .regex(/^\/\P{Cc}*$/u, { message: 'must be absolute and must not contain control characters' })
  .refine(isNormalized, {
    message: 'must be normalized: no empty, . or .. segment and no trailing slash',
  })
  .refine(
    (path) => path.isWellFormed() && new TextEncoder().encode(path).byteLength <= MAX_PATH_BYTES,
    {
      message: 'must be well-formed UTF-8 of at most 4096 bytes',
    },
  );

// Builds the schema for each kind with `object` making every object in it:
// strict where a provisioner records, so a field it misspells is refused, and
// stripping where the Hub reads a Report, so a field only a newer Collector
// knows is dropped rather than losing the record (ADR-0004). Strict and
// stripping objects differ only at run time, so one type covers both.
const recordSchemas = (
  object: <Shape extends z.core.$ZodShape>(shape: Shape) => z.ZodObject<Shape, z.core.$strict>,
) => {
  // Who recorded something, for Heimdall to show and never compare.
  const provenance = object({ by: text(64), revision: text(128).optional() }).optional();

  const application = object({ name, provenance, source: text().optional(), version: text(128) });

  const service = { health: loopbackUrl.optional(), name, port: port.optional(), provenance };

  // One calendar entry in the System's local time, with launchd
  // StartCalendarInterval meaning: a field left out matches every value.
  const calendarEntry = object({
    day: z.int().min(1).max(31).optional(),
    hour: z.int().min(0).max(23).optional(),
    minute: z.int().min(0).max(59).optional(),
    month: z.int().min(1).max(12).optional(),
    // 0 and 7 are both Sunday.
    weekday: z.int().min(0).max(7).optional(),
  }).refine((entry) => Object.keys(entry).length > 0, {
    message: 'an entry needs at least one field',
  });

  const job = {
    name,
    provenance,
    schedule: z
      .array(calendarEntry)
      .min(1)
      .max(MAX_SCHEDULE_ENTRIES)
      .refine((entries) => new Set(entries.map(entryKey)).size === entries.length, {
        message: 'duplicate schedule entry',
        // Only valid entries can be compared.
        when: ({ issues }) => issues.length === 0,
      }),
  };

  const file = object({ path: absolutePath, sha256: z.string().regex(/^[0-9a-f]{64}$/u) });

  return {
    application,
    files: object({
      files: z
        .array(file)
        .min(1)
        .max(MAX_FILES)
        .refine((files) => new Set(files.map(({ path }) => path)).size === files.length, {
          message: 'duplicate path',
          // Only valid files can be compared.
          when: ({ issues }) => issues.length === 0,
        }),
      name,
      provenance,
    }),
    // The shape depends on the scheduler, which decides what names the job to it.
    job: z.discriminatedUnion('scheduler', [
      object({ ...job, label: text(), scheduler: z.literal('launchd') }),
      object({ ...job, scheduler: z.literal('systemd-timer'), unit: text() }),
    ]),
    // The shape depends on the supervisor, which decides what names the Service to it.
    service: z.discriminatedUnion('supervisor', [
      object({ ...service, supervisor: z.literal('systemd'), unit: text() }),
      object({ ...service, supervisor: z.literal('systemd-user'), unit: text() }),
      object({ ...service, label: text(), supervisor: z.literal('launchd') }),
      object({ ...service, container: text(), supervisor: z.literal('docker') }),
      object({ ...service, supervisor: z.literal('none') }),
    ]),
  };
};

// The schema that checks a record of each kind as a provisioner records it.
export const RECORD_SCHEMAS = recordSchemas((shape) => z.strictObject(shape));

// The schema that reads a record of each kind from a Report.
export const REPORTED_RECORD_SCHEMAS = recordSchemas((shape) => z.strictObject(shape).strip());

export const ApplicationRecordSchema = RECORD_SCHEMAS.application;
export const ServiceRecordSchema = RECORD_SCHEMAS.service;
export const JobRecordSchema = RECORD_SCHEMAS.job;
export const FilesRecordSchema = RECORD_SCHEMAS.files;

export type ApplicationRecord = z.infer<typeof ApplicationRecordSchema>;
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
export type FilesRecord = z.infer<typeof FilesRecordSchema>;
// The record of kind `K`.
export type RecordOf<K extends RecordKind> = z.infer<(typeof RECORD_SCHEMAS)[K]>;

// A run's output file, by its name in the job's own output directory:
// printable ASCII without a slash, and neither `.` nor `..`, so it cannot name
// a path outside that directory.
const OutputSchema = z.strictObject({
  file: z
    .string()
    .max(255)
    .regex(/^(?!\.\.?$)[ -.0-~]+$/u),
  sizeBytes: bytes,
});

// Whole seconds in UTC, so the times compare exactly.
const second = z.iso.datetime({ precision: 0 });

// One run of a job, successful or not; exit status 0 is success.
export const RunRecordSchema = z
  .strictObject({
    exitStatus: z.int().min(0).max(255),
    finished: second,
    output: OutputSchema.optional(),
    started: second,
  })
  .refine(({ finished, started }) => Date.parse(finished) >= Date.parse(started), {
    message: 'a run finished before it started',
    path: ['finished'],
    // Only valid times can be compared.
    when: ({ issues }) => issues.length === 0,
  });

export type RunRecord = z.infer<typeof RunRecordSchema>;
