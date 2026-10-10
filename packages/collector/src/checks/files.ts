import type { FileCheckState } from '@heimdall/schema';

import { checkFile } from './file-check.ts';
import type { FileVerdict } from './file-check.ts';

// A recorded file that does not match, with when this Collector first saw it
// in that state.
export type FileMismatch = {
  path: string;
  record: string;
  since: number;
  state: FileCheckState;
};

// A files record to check, with the digest of its content.
export type FilesRecordToCheck = {
  digest: string;
  files: readonly { path: string; sha256: string }[];
  name: string;
};

// What one pass found: the digest of each record it hashed, and the files in
// them that do not match.
export type FilesPass = {
  fileRecords: { digest: string; record: string }[];
  mismatches: FileMismatch[];
};

const keyOf = ({ path, record }: Pick<FileMismatch, 'path' | 'record'>) =>
  JSON.stringify([record, path]);

// Compares every file the `records` name with disk, one at a time, and answers
// the digests of the records and the files that do not match, in record and
// file order. A file already mismatched in the same state keeps its `since`
// from `previous`; any other takes `now`. A path two records name is read once
// for each hash recorded for it. Answers undefined when `signal` aborts, since
// a partial pass would report the files it never reached as matching.
export const checkFiles = async ({
  now,
  previous,
  records,
  signal,
}: {
  now: number;
  previous: readonly FileMismatch[];
  records: readonly FilesRecordToCheck[];
  signal?: AbortSignal;
}): Promise<FilesPass | undefined> => {
  const before = new Map(previous.map((mismatch) => [keyOf(mismatch), mismatch]));
  const verdicts = new Map<string, FileVerdict>();
  const mismatches: FileMismatch[] = [];
  for (const { files, name } of records) {
    for (const { path, sha256 } of files) {
      const verdictKey = JSON.stringify([path, sha256]);
      let verdict = verdicts.get(verdictKey);
      if (verdict === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time keeps the disk load even.
        const checked = await checkFile(path, sha256, signal);
        if (checked === undefined) {
          return undefined;
        }
        verdict = checked;
        verdicts.set(verdictKey, verdict);
      }
      if (verdict !== 'match') {
        const held = before.get(keyOf({ path, record: name }));
        mismatches.push({
          path,
          record: name,
          since: held?.state === verdict ? held.since : now,
          state: verdict,
        });
      }
    }
  }
  return {
    fileRecords: records.map(({ digest, name }) => ({ digest, record: name })),
    mismatches,
  };
};
