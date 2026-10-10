import { z } from 'zod';

import { RECORD_NAME } from './records.ts';
import { bytes, epochMs } from './values.ts';

// The most bytes of JSON one part of a Collector's checks section may take in a
// Report. A file that does not match comes to about 200 bytes and a hashed
// record to about 130, so 1 MiB holds about 5,000 mismatched files. A part over
// it travels as a marker, and the other parts travel as they are.
export const MAX_CHECKS_PART_BYTES = 1024 * 1024;

// How a recorded file can fail to match, in the order the Hub reads them: its
// content differs from the recorded hash, it does not exist, or the Collector
// could not read it (permission denied, a directory, a special file).
export const FILE_CHECK_STATES = ['drifted', 'missing', 'unreadable'] as const;
export type FileCheckState = (typeof FILE_CHECK_STATES)[number];

// How a Service can be checked, and what a check can find. A supervisor check
// asks the supervisor that runs the Service whether it is up. A Service is
// `stopped` when its supervisor says it is not running, `unknown` when the
// Collector could not ask or got no answer, and `unchecked` when this Collector
// does not check that supervisor. A health check requests the Service's
// loopback health URL, and finds it `unhealthy` when it does not answer with a
// 2xx or 3xx status. Later checks join as further kinds, and a state they add
// joins the states.
export const SERVICE_CHECK_KINDS = ['supervisor', 'health'] as const;
export type ServiceCheckKind = (typeof SERVICE_CHECK_KINDS)[number];

export const SERVICE_CHECK_STATES = ['up', 'stopped', 'unhealthy', 'unknown', 'unchecked'] as const;
export type ServiceCheckState = (typeof SERVICE_CHECK_STATES)[number];

const MAX_PATH_LENGTH = 4096;
// The most characters of `detail` the Hub takes in a check.
export const MAX_CHECK_DETAIL_LENGTH = 200;

// A file that does not match, as the Collector sends it. The state is any short
// word, so a state only a newer Collector knows does not reject a Report
// (ADR-0004). `since` is when the Collector's clock first saw the file in this
// state.
const SentFileCheckSchema = z.object({
  path: z.string().min(1).max(MAX_PATH_LENGTH),
  record: z.string().regex(RECORD_NAME),
  since: epochMs,
  state: z.string().min(1).max(64),
});

// One check of a Service, as the Collector sends it. The kind and state are any
// short word, so one only a newer Collector knows does not reject a Report
// (ADR-0004). `detail` says in a few words what the check found, such as
// `ActiveState=failed`. `since` is when the Collector's clock first saw the
// check in this state.
const SentServiceCheckSchema = z.object({
  check: z.string().min(1).max(64),
  detail: z.string().max(MAX_CHECK_DETAIL_LENGTH),
  service: z.string().regex(RECORD_NAME),
  since: epochMs,
  state: z.string().min(1).max(64),
});

// A files record the Collector hashed, with the digest of the record it read.
// The Hub trusts the Collector's verdict on a record's files only when its
// digest equals that of the record the Hub mirrors, since the two can differ
// while a change travels (ADR-0011).
const SentFileRecordSchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  record: z.string().regex(RECORD_NAME),
});

const PartOverBudgetSchema = z.object({ bytes });

// The size of each part a Collector sent as a marker because it was too large.
const OverBudgetSchema = z
  .object({ files: PartOverBudgetSchema.optional(), services: PartOverBudgetSchema.optional() })
  .optional();

// A Report's checks section: what the Collector observed on this System
// against what its provisioner recorded, in parts. The files part is
// `fileRecords`, which lists the files records the Collector hashed, and
// `files`, only the recorded files in them that do not match, so an empty
// `files` says every file in the records listed matches. The services part,
// `services`, lists each check of each recorded Service. Every part is
// optional, and later checks join as further parts, so a section from a newer
// Collector that carries only parts this Hub does not know still parses; a Hub
// drops a part it does not know. A Collector sends the section when it
// changes, when it starts, and hourly; the Hub replaces the System's latest
// checks with it. A part over budget is sent as its size in `overBudget`,
// named for the part, and the other parts are sent as they are.
export const ChecksSectionSchema = z.object({
  fileRecords: z.array(SentFileRecordSchema).optional(),
  files: z.array(SentFileCheckSchema).optional(),
  overBudget: OverBudgetSchema,
  services: z.array(SentServiceCheckSchema).optional(),
});

// The digest of a files record: SHA-256, in hexadecimal, of its files in path
// order (by code unit) as `path`, NUL, `sha256`, and a newline each. A path has
// no control character, so the lines cannot be read two ways, and the order in
// which a provisioner listed the files does not matter. The Collector and the
// Hub both compute it, so each can say which version of a record a verdict is
// about. It uses Web Crypto, so it is asynchronous and the schema package stays
// free of Node builtins.
export const filesRecordDigest = async ({
  files,
}: {
  files: readonly { path: string; sha256: string }[];
}): Promise<string> => {
  const ordered = files.toSorted((a, b) => {
    if (a.path === b.path) {
      return 0;
    }
    return a.path < b.path ? -1 : 1;
  });
  const lines = ordered.map(({ path, sha256 }) => `${path}\0${sha256}\n`).join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(lines));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export type ChecksSection = z.infer<typeof ChecksSectionSchema>;
export type SentFileCheck = z.infer<typeof SentFileCheckSchema>;
export type SentFileRecord = z.infer<typeof SentFileRecordSchema>;
export type SentServiceCheck = z.infer<typeof SentServiceCheckSchema>;

// A recorded file that does not match, as the Hub mirrors it.
export type FileCheck = {
  path: string;
  record: string;
  since: number;
  state: FileCheckState;
};

// A files record the Collector hashed, as the Hub mirrors it.
export type FileRecordCheck = SentFileRecord;

// A check of a Service, as the Hub mirrors it.
export type ServiceCheck = {
  check: ServiceCheckKind;
  detail: string;
  service: string;
  since: number;
  state: ServiceCheckState;
};

// A System's latest checks as the Hub mirrors them. A part the section left out
// mirrors as null, since no list of checks is not the same as an empty one: the
// files part says every file in the records it lists matches only when it is
// there. A part sent as over budget mirrors as its size in bytes and none of
// its entries.
export type MirroredChecks = {
  fileRecords: FileRecordCheck[] | null;
  files: FileCheck[] | null;
  filesOverBudgetBytes: number | null;
  services: ServiceCheck[] | null;
  servicesOverBudgetBytes: number | null;
};

const isFileCheckState = (state: string): state is FileCheckState =>
  FILE_CHECK_STATES.some((known) => known === state);

const isServiceCheckKind = (kind: string): kind is ServiceCheckKind =>
  SERVICE_CHECK_KINDS.some((known) => known === kind);

const isServiceCheckState = (state: string): state is ServiceCheckState =>
  SERVICE_CHECK_STATES.some((known) => known === state);

const mirrorFiles = (section: ChecksSection, sent: readonly SentFileCheck[]) => {
  const files = new Map<string, FileCheck>();
  for (const { path, record, since, state } of sent) {
    files.set(JSON.stringify([record, path]), {
      path,
      record,
      since,
      state: isFileCheckState(state) ? state : 'unreadable',
    });
  }
  const fileRecords = new Map<string, FileRecordCheck>();
  for (const entry of section.fileRecords ?? []) {
    fileRecords.set(entry.record, entry);
  }
  return { fileRecords: [...fileRecords.values()], files: [...files.values()] };
};

const mirrorServices = (sent: readonly SentServiceCheck[]) => {
  const checks = new Map<string, ServiceCheck>();
  for (const { check, detail, service, since, state } of sent) {
    if (isServiceCheckKind(check)) {
      checks.set(JSON.stringify([service, check]), {
        check,
        detail,
        service,
        since,
        state: isServiceCheckState(state) ? state : 'unknown',
      });
    }
  }
  return [...checks.values()];
};

// The checks a Hub mirrors from a checks section. A file state this Hub does
// not know means the file does not match in some way, so it counts as
// unreadable rather than as a match, and a Service state it does not know
// counts as unknown rather than up. A check of a kind it does not know is
// dropped. A file sent twice under one record keeps the last, and so does a
// record's digest and a Service's check. A section with no `files` part has
// not finished a file pass yet, or is from a newer Collector that judges
// differently, so it judges no record here and mirrors no files.
export const mirrorChecks = (section: ChecksSection): MirroredChecks => {
  const filesOverBudgetBytes = section.overBudget?.files?.bytes ?? null;
  const servicesOverBudgetBytes = section.overBudget?.services?.bytes ?? null;
  return {
    ...(filesOverBudgetBytes === null && section.files !== undefined
      ? mirrorFiles(section, section.files)
      : { fileRecords: null, files: null }),
    filesOverBudgetBytes,
    services:
      servicesOverBudgetBytes === null && section.services !== undefined
        ? mirrorServices(section.services)
        : null,
    servicesOverBudgetBytes,
  };
};

// A mirrored file check as `GET /api/v1/records` returns it: `since` is UTC
// ISO 8601 text.
const FileCheckReadSchema = z.object({
  path: z.string(),
  record: z.string(),
  since: z.string(),
  state: z.enum(FILE_CHECK_STATES),
});

// A files record the Collector hashed, with the digest it read.
const FileRecordReadSchema = z.object({ digest: z.string(), record: z.string() });

// A mirrored Service check as `GET /api/v1/records` returns it: `since` is UTC
// ISO 8601 text.
const ServiceCheckReadSchema = z.object({
  check: z.enum(SERVICE_CHECK_KINDS),
  detail: z.string(),
  service: z.string(),
  since: z.string(),
  state: z.enum(SERVICE_CHECK_STATES),
});

// A System's latest checks as the read returns them, or null until a Report
// carries them, which a Collector older than checks never sends. A part
// too large to send is named in `overBudget` with its size
// and left out; `services` is also left out when the Collector sent no
// services part, which is not the same as an empty list. Times are ISO 8601.
export const ChecksReadSchema = z.union([
  z.object({
    fileRecords: z.array(FileRecordReadSchema).optional(),
    files: z.array(FileCheckReadSchema).optional(),
    overBudget: OverBudgetSchema,
    receivedAt: z.string(),
    sentAt: z.string(),
    services: z.array(ServiceCheckReadSchema).optional(),
  }),
  z.null(),
]);
