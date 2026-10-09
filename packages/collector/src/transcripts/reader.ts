import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCallback } from 'node:zlib';

import { OpenGenerationSchema } from '@heimdall/schema';

import { describeError } from '../errors.ts';
import { cutChunks } from './chunks.ts';
import type { Source } from './sources.ts';
import type { FileRecord, Fingerprint, Spool } from './spool.ts';

const gzip = promisify(gzipCallback);

// How many bytes at each end of what was read are hashed to notice the file
// change under the Collector.
const WINDOW_BYTES = 4096;

export type SourceStatus = 'absent' | 'capturing' | 'unreadable';

const hash = (bytes: Uint8Array) => Bun.hash.xxHash64(bytes).toString(16);

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;

export const isGone = (error: unknown) =>
  errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

// A directory entry's name as text, or undefined when it is not valid UTF-8.
const nameOf = (raw: Buffer) => {
  try {
    return strictUtf8.decode(raw);
  } catch {
    return undefined;
  }
};

const fingerprintOf = (stats: Fingerprint): Fingerprint => ({
  dev: stats.dev,
  ino: stats.ino,
  mtimeMs: stats.mtimeMs,
  size: stats.size,
});

const sameFingerprint = (a: Fingerprint, b: Fingerprint) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

const readAt = async (handle: FileHandle, position: number, length: number) => {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
};

// Opens `path` for reading only if it is a regular file: a symbolic link put
// in its place is not followed, and a FIFO does not block. Undefined for
// anything else, or when the file is gone.
export const openRegular = async (path: string) => {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (isGone(error) || errorCode(error) === 'ELOOP') {
      return undefined;
    }
    throw error;
  }
  const stats = await handle.stat().catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  if (!stats.isFile()) {
    await handle.close();
    return undefined;
  }
  return { handle, seen: fingerprintOf(stats) };
};

// Whether the source's directory is there and readable.
export const statusOf = async (source: Source): Promise<SourceStatus> => {
  try {
    await readdir(source.dir);
    return 'capturing';
  } catch (error) {
    return isGone(error) ? 'absent' : 'unreadable';
  }
};

// Reads sources' session trees into the spool (ADR-0013): each file's new
// content, as chunks ending on line boundaries, spooled before the file's
// read offset moves past it. A file whose bytes already read change under
// the Collector starts over in a new generation, so no generation joins two
// contents. `warn` is called once per run for each path it cannot use.
export const createReader = ({
  chunkLimit,
  now,
  readBytes = 4 * chunkLimit,
  signal,
  spool,
  warn,
}: {
  chunkLimit: number;
  now: () => number;
  readBytes?: number;
  signal?: AbortSignal | undefined;
  spool: Spool;
  warn: (key: string, message: string) => void;
}) => {
  // Reads the file from where the Collector left off to its size when it was
  // opened, spooling the new content. Before each block it checks that the
  // bytes it read before are still there; when they are not, the file starts
  // over in a new generation at the next scan.
  const readNew = async (handle: FileHandle, record: FileRecord) => {
    const final = record.stableScans >= 1;
    const { size } = record;
    let offset = record.readOffset;
    let headHash = record.headHash ?? hash(new Uint8Array());
    let tailHash = record.tailHash ?? hash(new Uint8Array());
    while (offset < size) {
      if (signal?.aborted === true) {
        return;
      }
      const start = Math.max(0, offset - WINDOW_BYTES);
      // oxlint-disable-next-line no-await-in-loop -- a file is read in order.
      const block = await readAt(handle, start, Math.min(offset - start + readBytes, size - start));
      if (block.length <= offset - start) {
        return;
      }
      if (offset > WINDOW_BYTES) {
        // oxlint-disable-next-line no-await-in-loop -- one small read a block.
        const head = await readAt(handle, 0, WINDOW_BYTES);
        if (hash(head) !== headHash) {
          spool.restart(record.id);
          return;
        }
      }
      if (hash(block.subarray(0, offset - start)) !== tailHash) {
        spool.restart(record.id);
        return;
      }
      const fresh = block.subarray(offset - start);
      const reachesEnd = start + block.length >= size;
      const cut = cutChunks(fresh, { final: final && reachesEnd, limit: chunkLimit });
      if (cut.consumed === 0) {
        return;
      }
      let position = offset;
      const chunks = [];
      for (const chunk of cut.chunks) {
        // oxlint-disable-next-line no-await-in-loop -- one chunk at a time keeps memory flat.
        chunks.push({ body: await gzip(chunk), length: chunk.length, offset: position });
        position += chunk.length;
      }
      const end = offset + cut.consumed;
      const upTo = block.subarray(0, end - start);
      if (start === 0) {
        headHash = hash(upTo.subarray(0, WINDOW_BYTES));
      }
      tailHash = hash(upTo.subarray(Math.max(0, upTo.length - WINDOW_BYTES)));
      spool.append(record.id, { chunks, headHash, readOffset: end, spooledAt: now(), tailHash });
      offset = end;
    }
  };

  // Spools what one file gained since the last scan. A file that is not JSONL
  // uploads whole once it is unchanged across two scans, and any change to it
  // afterwards starts it over.
  const readFile = async (source: Source, path: string, listed: Fingerprint) => {
    const before = spool.file(source.name, path);
    if (before?.refused === true) {
      return;
    }
    // Nothing to read: unchanged since a scan that found it unchanged, and read to its end.
    if (
      before !== undefined &&
      sameFingerprint(before, listed) &&
      before.stableScans >= 1 &&
      before.readOffset >= before.size
    ) {
      return;
    }
    const opened = await openRegular(join(source.dir, path));
    if (opened === undefined) {
      return;
    }
    const { handle, seen } = opened;
    try {
      const unchanged = before !== undefined && sameFingerprint(before, seen);
      let record = spool.observe(source.name, path, seen, unchanged ? 1 : 0);
      const jsonl = path.endsWith('.jsonl');
      if (record.generation !== null) {
        const replaced =
          before !== undefined && (before.dev !== seen.dev || before.ino !== seen.ino);
        const shrank = seen.size < record.readOffset;
        if (replaced || shrank || (!jsonl && !unchanged)) {
          spool.restart(record.id);
          record = spool.observe(source.name, path, seen, 0);
        }
      }
      if (!jsonl && !unchanged) {
        return;
      }
      // A JSONL file that started over is read from its first byte at once;
      // the handle holds the file as it is now.
      await readNew(handle, record);
    } finally {
      await handle.close();
    }
  };

  // Every regular file under `tree`, with its path relative to the source,
  // and what lstat saw of it. Symbolic links inside the tree are not
  // followed. Names that are not UTF-8 have no path the Hub accepts, so they
  // are skipped. Answers unreadable when the tree itself cannot be listed.
  const walk = async (
    source: Source,
    tree: string,
  ): Promise<{ listed: Fingerprint; path: string }[] | 'unreadable'> => {
    const files: { listed: Fingerprint; path: string }[] = [];
    const pending = [tree];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const relative = next;
      let names: Buffer[];
      try {
        // oxlint-disable-next-line no-await-in-loop -- one directory at a time.
        names = await readdir(join(source.dir, relative), { encoding: 'buffer' });
      } catch (error) {
        if (isGone(error)) {
          continue;
        }
        if (relative === tree) {
          return 'unreadable';
        }
        warn(
          `${source.name}/${relative}`,
          `Could not read ${join(source.dir, relative)}: ${describeError(error)}`,
        );
        continue;
      }
      for (const raw of names) {
        const name = nameOf(raw);
        if (name === undefined) {
          warn(
            `${source.name}/${relative}/${raw.toString('hex')}`,
            `Skipping ${join(source.dir, relative, raw.toString('utf8'))}: its name is not UTF-8.`,
          );
          continue;
        }
        const path = `${relative}/${name}`;
        // oxlint-disable-next-line no-await-in-loop -- one entry at a time.
        const stats = await lstat(join(source.dir, path)).catch(() => undefined);
        if (stats?.isDirectory() === true) {
          pending.push(path);
        } else if (stats?.isFile() === true) {
          if (OpenGenerationSchema.shape.path.safeParse(path).success) {
            files.push({ listed: fingerprintOf(stats), path });
          } else {
            warn(
              `${source.name}/${path}`,
              `Skipping ${join(source.dir, path)}: the Hub cannot store its path.`,
            );
          }
        }
      }
    }
    return files.toSorted((a, b) => (a.path < b.path ? -1 : 1));
  };

  return {
    // Reads the source's session trees, file by file. One file that cannot be
    // read is skipped with a warning; a tree that cannot be listed makes the
    // source unreadable.
    readSource: async (source: Source): Promise<SourceStatus> => {
      let status: SourceStatus = 'capturing';
      for (const tree of source.trees) {
        // oxlint-disable-next-line no-await-in-loop -- one tree at a time.
        const files = await walk(source, tree);
        if (files === 'unreadable') {
          status = 'unreadable';
          continue;
        }
        for (const { listed, path } of files) {
          if (signal?.aborted === true) {
            return status;
          }
          try {
            // oxlint-disable-next-line no-await-in-loop -- one file at a time.
            await readFile(source, path, listed);
          } catch (error) {
            warn(
              `${source.name}/${path}`,
              `Could not read ${join(source.dir, path)}: ${describeError(error)}`,
            );
          }
        }
      }
      return status;
    },
  };
};
