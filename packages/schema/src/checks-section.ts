import { z } from 'zod';

import { RECORD_NAME } from './records.ts';
import { bytes, epochMs } from './values.ts';

// The most bytes of JSON a Collector's checks section may take in a Report.
// A file that does not match comes to about 200 bytes, so 1 MiB holds the
// files of thousands of records. Checks over it travel as a marker.
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

// A Report's checks section: what the Collector observed on this System
// against what its provisioner recorded. `files` lists only the recorded files
// that do not match, so an empty list says every one does. Later checks join as
// further parts beside `files`, and a Hub drops a part it does not know. A
// Collector sends the section when it changes, when it starts, and hourly; the
// Hub replaces the System's latest checks with it. Checks over budget are sent
// as their size alone.
export const ChecksSectionSchema = z.union([
  z.object({ files: z.array(SentFileCheckSchema) }),
  z.object({ overBudget: z.object({ bytes }) }),
]);

export type ChecksSection = z.infer<typeof ChecksSectionSchema>;
export type SentFileCheck = z.infer<typeof SentFileCheckSchema>;

// A recorded file that does not match, as the Hub mirrors it.
export type FileCheck = {
  path: string;
  record: string;
  since: number;
  state: FileCheckState;
};

// A System's latest checks as the Hub mirrors them, or the size of checks it
// could not be sent.
export type MirroredChecks = { files: FileCheck[] } | { overBudget: { bytes: number } };

const isFileCheckState = (state: string): state is FileCheckState =>
  FILE_CHECK_STATES.some((known) => known === state);

// The checks a Hub mirrors from a checks section. A state this Hub does not
// know means the file does not match in some way, so it counts as unreadable
// rather than as a match. A file sent twice under one record keeps the last.
export const mirrorChecks = (section: ChecksSection): MirroredChecks => {
  if ('overBudget' in section) {
    return { overBudget: section.overBudget };
  }
  const files = new Map<string, FileCheck>();
  for (const { path, record, since, state } of section.files) {
    files.set(JSON.stringify([record, path]), {
      path,
      record,
      since,
      state: isFileCheckState(state) ? state : 'unreadable',
    });
  }
  return { files: [...files.values()] };
};

// A mirrored file check as `GET /api/v1/records` returns it: `since` is UTC
// ISO 8601 text.
const FileCheckReadSchema = z.object({
  path: z.string(),
  record: z.string(),
  since: z.string(),
  state: z.enum(FILE_CHECK_STATES),
});

// A System's latest checks as the read returns them: the files that do not
// match, the size of checks too large to send, or null until a Report carries
// them, which a Collector older than checks never sends. Times are ISO 8601.
export const ChecksReadSchema = z.union([
  z.object({ files: z.array(FileCheckReadSchema), receivedAt: z.string(), sentAt: z.string() }),
  z.object({ overBudget: z.object({ bytes }), receivedAt: z.string(), sentAt: z.string() }),
  z.null(),
]);
