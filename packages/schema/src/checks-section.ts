import { z } from 'zod';

import { RECORD_NAME } from './records.ts';
import { bytes, epochMs } from './values.ts';

// The most bytes of JSON a Collector's checks section may take in a Report. A
// file that does not match comes to about 200 bytes and a hashed record to
// about 130, so 1 MiB holds about 5,000 mismatched files. Checks over it travel
// as a marker.
export const MAX_CHECKS_SECTION_BYTES = 1024 * 1024;

// How a recorded file can fail to match, in the order the Hub reads them: its
// content differs from the recorded hash, it does not exist, or the Collector
// could not read it (permission denied, a directory, a special file).
export const FILE_CHECK_STATES = ['drifted', 'missing', 'unreadable'] as const;
export type FileCheckState = (typeof FILE_CHECK_STATES)[number];

const MAX_PATH_LENGTH = 4096;

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

// A files record the Collector hashed, with the digest of the record it read.
// The Hub trusts the Collector's verdict on a record's files only when its
// digest equals that of the record the Hub mirrors, since the two can differ
// while a change travels (ADR-0011).
const SentFileRecordSchema = z.object({
  digest: z.string().regex(/^[0-9a-f]{64}$/u),
  record: z.string().regex(RECORD_NAME),
});

// A Report's checks section: what the Collector observed on this System
// against what its provisioner recorded. `fileRecords` lists the files records
// the Collector hashed, and `files` only the recorded files in them that do not
// match, so an empty `files` says every file in the records listed matches.
// Every part is optional, and later checks join as further parts, so a section
// from a newer Collector that carries only parts this Hub does not know still
// parses; a Hub drops a part it does not know. A Collector sends the section
// when it changes, when it starts, and hourly; the Hub replaces the System's
// latest checks with it. Checks over budget are sent as their size alone.
export const ChecksSectionSchema = z.union([
  z.object({ overBudget: z.object({ bytes }) }),
  z.object({
    fileRecords: z.array(SentFileRecordSchema).optional(),
    files: z.array(SentFileCheckSchema).optional(),
  }),
]);

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

// A recorded file that does not match, as the Hub mirrors it.
export type FileCheck = {
  path: string;
  record: string;
  since: number;
  state: FileCheckState;
};

// A files record the Collector hashed, as the Hub mirrors it.
export type FileRecordCheck = SentFileRecord;

// A System's latest checks as the Hub mirrors them, or the size of checks it
// could not be sent. A part the section left out mirrors as empty.
export type MirroredChecks =
  | { fileRecords: FileRecordCheck[]; files: FileCheck[] }
  | { overBudget: { bytes: number } };

const isFileCheckState = (state: string): state is FileCheckState =>
  FILE_CHECK_STATES.some((known) => known === state);

// The checks a Hub mirrors from a checks section. A state this Hub does not
// know means the file does not match in some way, so it counts as unreadable
// rather than as a match. A file sent twice under one record keeps the last, and
// so does a record's digest. A section with no `files` part is from a newer
// Collector that judges differently, so it judges no record here.
export const mirrorChecks = (section: ChecksSection): MirroredChecks => {
  if ('overBudget' in section) {
    return { overBudget: section.overBudget };
  }
  const files = new Map<string, FileCheck>();
  for (const { path, record, since, state } of section.files ?? []) {
    files.set(JSON.stringify([record, path]), {
      path,
      record,
      since,
      state: isFileCheckState(state) ? state : 'unreadable',
    });
  }
  const fileRecords = new Map<string, FileRecordCheck>();
  for (const entry of section.files === undefined ? [] : (section.fileRecords ?? [])) {
    fileRecords.set(entry.record, entry);
  }
  return { fileRecords: [...fileRecords.values()], files: [...files.values()] };
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

// A System's latest checks as the read returns them: the digest of each files
// record the Collector hashed and the files that do not match, the size of
// checks too large to send, or null until a Report carries them, which a
// Collector older than checks never sends. Times are ISO 8601.
export const ChecksReadSchema = z.union([
  z.object({
    fileRecords: z.array(FileRecordReadSchema),
    files: z.array(FileCheckReadSchema),
    receivedAt: z.string(),
    sentAt: z.string(),
  }),
  z.object({ overBudget: z.object({ bytes }), receivedAt: z.string(), sentAt: z.string() }),
  z.null(),
]);
