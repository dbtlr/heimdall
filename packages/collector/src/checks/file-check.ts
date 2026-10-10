import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// What the Collector found when it compared a recorded file with disk. A file
// it could not read is not a mismatch: the Hub judges it neither way.
export type FileVerdict = 'match' | 'drifted' | 'missing' | 'unreadable';

// A path that is not there, or has a file where a directory should be.
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);

const failureOf = (error: unknown): FileVerdict =>
  error instanceof Error && 'code' in error && NOT_THERE.has(String(error.code))
    ? 'missing'
    : 'unreadable';

// Compares the file at `path`, following symbolic links, with the SHA-256 a
// provisioner recorded for it. The content is hashed as a stream, so a large
// file is never held in memory. Only a regular file is read: opening a named
// pipe without O_NONBLOCK would wait for a writer, and a directory or device
// has no content to compare.
export const checkFile = async (path: string, sha256: string): Promise<FileVerdict> => {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) {
        return 'unreadable';
      }
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        hash.update(chunk);
      }
      return hash.digest('hex') === sha256 ? 'match' : 'drifted';
    } finally {
      await handle.close();
    }
  } catch (error) {
    return failureOf(error);
  }
};
