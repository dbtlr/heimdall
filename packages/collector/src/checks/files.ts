import type { FileCheckState } from '@heimdall/schema';

import type { StoredRecord } from '../records.ts';
import { checkFile } from './file-check.ts';

// A recorded file that does not match, with when this Collector first saw it
// in that state.
export type FileMismatch = {
  path: string;
  record: string;
  since: number;
  state: FileCheckState;
};

const keyOf = ({ path, record }: Pick<FileMismatch, 'path' | 'record'>) =>
  JSON.stringify([record, path]);

// Compares every file the `files` records name with disk, one at a time, and
// answers those that do not match, in record and file order. A file already
// mismatched in the same state keeps its `since` from `previous`; any other
// takes `now`. A path two records name is read once for each hash recorded
// for it. Answers undefined when `signal` aborts, since a partial pass would
// report the files it never reached as matching.
export const checkFiles = async ({
  now,
  previous,
  records,
  signal,
}: {
  now: number;
  previous: readonly FileMismatch[];
  records: readonly StoredRecord[];
  signal?: AbortSignal;
}): Promise<FileMismatch[] | undefined> => {
  const before = new Map(previous.map((mismatch) => [keyOf(mismatch), mismatch]));
  const verdicts = new Map<string, Awaited<ReturnType<typeof checkFile>>>();
  const found: FileMismatch[] = [];
  for (const { kind, name, record } of records) {
    if (kind !== 'files' || !('files' in record)) {
      continue;
    }
    for (const { path, sha256 } of record.files) {
      if (signal?.aborted === true) {
        return undefined;
      }
      const verdictKey = JSON.stringify([path, sha256]);
      let verdict = verdicts.get(verdictKey);
      if (verdict === undefined) {
        // oxlint-disable-next-line no-await-in-loop -- one file at a time keeps the disk load even.
        verdict = await checkFile(path, sha256);
        verdicts.set(verdictKey, verdict);
      }
      if (verdict !== 'match') {
        const held = before.get(keyOf({ path, record: name }));
        found.push({
          path,
          record: name,
          since: held?.state === verdict ? held.since : now,
          state: verdict,
        });
      }
    }
  }
  return found;
};
