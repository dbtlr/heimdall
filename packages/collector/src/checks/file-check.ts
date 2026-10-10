import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';

// What the Collector found when it compared a recorded file with disk. A file
// it could not read is not a mismatch: the Hub judges it neither way.
export type FileVerdict = 'match' | 'drifted' | 'missing' | 'unreadable';

// A path that is not there, or has a file where a directory should be.
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR']);

const failureOf = (error: unknown): FileVerdict =>
  error instanceof Error && 'code' in error && NOT_THERE.has(String(error.code))
    ? 'missing'
    : 'unreadable';

// The file system calls a check makes, which a test replaces to watch them or
// to change a file between them.
export type FileSystem = { open: typeof open; stat: typeof stat };

const REAL_FILE_SYSTEM: FileSystem = { open, stat };

// Hashes the first `size` bytes of `handle`, or answers undefined when `signal`
// aborts between chunks. A file that grew since it was opened is read only as
// far as it was then, so a file growing faster than it is read cannot stall the
// pass.
const hashPrefix = async (
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  signal: AbortSignal | undefined,
) => {
  const hash = createHash('sha256');
  if (size > 0) {
    // `end` is the last byte to read, inclusive.
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      end: size - 1,
      start: 0,
    })) {
      if (signal?.aborted === true) {
        return undefined;
      }
      hash.update(chunk);
    }
  }
  return signal?.aborted === true ? undefined : hash.digest('hex');
};

// Compares the file at `path`, following symbolic links, with the SHA-256 a
// provisioner recorded for it. The content is hashed as a stream, so a large
// file is never held in memory. Only a regular file is opened: the path is
// examined first so a device is never opened, the open does not wait for a
// writer on a named pipe, and the opened file is examined again in case the
// path changed in between. Answers undefined when `signal` aborts, so stopping
// does not wait for a huge file.
export const checkFile = async (
  path: string,
  sha256: string,
  signal?: AbortSignal,
  fs: FileSystem = REAL_FILE_SYSTEM,
): Promise<FileVerdict | undefined> => {
  try {
    if (signal?.aborted === true) {
      return undefined;
    }
    if (!(await fs.stat(path)).isFile()) {
      return 'unreadable';
    }
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) {
        return 'unreadable';
      }
      const digest = await hashPrefix(handle, opened.size, signal);
      if (digest === undefined) {
        return undefined;
      }
      return digest === sha256 ? 'match' : 'drifted';
    } finally {
      await handle.close();
    }
  } catch (error) {
    return failureOf(error);
  }
};
