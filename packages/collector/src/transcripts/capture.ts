import { lstat, open, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';

import {
  MAX_TRANSCRIPT_CHUNK_BYTES,
  MAX_TRANSCRIPT_REQUEST_BYTES,
  OpenGenerationSchema,
} from '@heimdall/schema';
import type { TranscriptsSection } from '@heimdall/schema';

import { describeError } from '../errors.ts';
import { cutChunks } from './chunks.ts';
import type { TranscriptHub } from './hub-client.ts';
import type { Source } from './sources.ts';
import type { FileRecord, Fingerprint, PendingGeneration, Spool } from './spool.ts';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

// How many bytes at each end of what was read are hashed to notice the file
// change under the Collector.
const WINDOW_BYTES = 4096;
// How much of a file one read takes in, a few chunks' worth.
const READ_BYTES = 4 * MAX_TRANSCRIPT_CHUNK_BYTES;
// How many spooled chunks one drain step considers joining.
const JOIN_CANDIDATES = 64;

export type SourceStatus = 'absent' | 'capturing' | 'unreadable';

export type DrainResult = { kind: 'drained' } | { kind: 'failed'; reason: string };

type Log = { warn: (message: string) => unknown };

const hash = (bytes: Uint8Array) => Bun.hash.xxHash64(bytes).toString(16);

const errorCode = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;

const isGone = (error: unknown) => errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

// A directory entry's name as text, or undefined when it is not valid UTF-8.
const nameOf = (raw: Buffer) => {
  try {
    return strictUtf8.decode(raw);
  } catch {
    return undefined;
  }
};

const fingerprintOf = (stats: {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}): Fingerprint => ({
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

const concat = (parts: Uint8Array[]) => Buffer.concat(parts);

// Whether the source's directory is there and readable.
const statusOf = async (source: Source): Promise<SourceStatus> => {
  try {
    await readdir(source.dir);
    return 'capturing';
  } catch (error) {
    return isGone(error) ? 'absent' : 'unreadable';
  }
};

// Captures the transcripts of `sources` into `spool` and drains the spool to
// `hub` (ADR-0013). `scan` reads what each source's files gained since the
// last scan; `drain` uploads what the spool holds, oldest generation first,
// including what sources no longer configured left behind. `section` is the
// Report's transcripts section.
export const createCapture = ({
  chunkLimit = MAX_TRANSCRIPT_CHUNK_BYTES,
  hub,
  log,
  now,
  sources,
  spool,
}: {
  chunkLimit?: number | undefined;
  hub: TranscriptHub;
  log: Log;
  now: () => number;
  sources: readonly Source[];
  spool: Spool;
}) => {
  const statuses = new Map<string, SourceStatus>();
  // Warn about each unusable path once per run, not once a scan.
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (!warned.has(key)) {
      warned.add(key);
      log.warn(message);
    }
  };

  // Spools what the file gained, starting a new generation when what it read
  // before no longer matches the file.
  const readFile = async (source: Source, path: string, absolute: string) => {
    let handle: FileHandle;
    try {
      handle = await open(absolute, 'r');
    } catch (error) {
      if (!isGone(error)) {
        warnOnce(`${source.name}/${path}`, `Could not read ${absolute}: ${describeError(error)}`);
      }
      return;
    }
    try {
      const seen = fingerprintOf(await handle.stat());
      const before = spool.file(source.name, path);
      if (before?.refused === true) {
        return;
      }
      const unchanged = before !== undefined && sameFingerprint(before, seen);
      const record = spool.observe(
        source.name,
        path,
        seen,
        unchanged ? (before?.stableScans ?? 0) + 1 : 0,
      );
      const jsonl = path.endsWith('.jsonl');
      const final = record.stableScans >= 1;
      if (record.generation !== null) {
        const replaced =
          before !== undefined && (before.dev !== seen.dev || before.ino !== seen.ino);
        const shrank = seen.size < record.readOffset;
        // A file that is not JSONL uploads whole, so any change starts it over.
        const changed = !jsonl && !unchanged;
        if (replaced || shrank || changed) {
          spool.restart(record.id);
          // Content that is not JSONL waits again until it holds still.
          if (jsonl) {
            await readNew(handle, source.name, spool.observe(source.name, path, seen, 0));
          }
          return;
        }
      }
      if (!jsonl && !final) {
        return;
      }
      await readNew(handle, source.name, record);
    } finally {
      await handle.close();
    }
  };

  // Reads the file from where the Collector left off to its size at the scan,
  // checks the bytes it read before are still there, and spools the new
  // content chunk by chunk.
  const readNew = async (handle: FileHandle, sourceName: string, initial: FileRecord) => {
    let record = initial;
    const final = record.stableScans >= 1;
    const { size } = record;
    let offset = record.readOffset;
    let headHash = record.headHash ?? hash(new Uint8Array());
    let tailHash = record.tailHash ?? hash(new Uint8Array());
    let checked = offset === 0;
    while (offset < size) {
      const start = Math.max(0, offset - WINDOW_BYTES);
      // oxlint-disable-next-line no-await-in-loop -- a file is read in order.
      const block = await readAt(handle, start, Math.min(READ_BYTES, size - start));
      if (block.length <= offset - start) {
        return;
      }
      if (!checked) {
        checked = true;
        const head =
          offset <= WINDOW_BYTES
            ? block.subarray(0, offset)
            : // oxlint-disable-next-line no-await-in-loop -- once per file.
              await readAt(handle, 0, WINDOW_BYTES);
        if (
          hash(head) !== record.headHash ||
          hash(block.subarray(0, offset - start)) !== record.tailHash
        ) {
          spool.restart(record.id);
          record = spool.observe(sourceName, record.path, record, 0);
          offset = 0;
          headHash = hash(new Uint8Array());
          tailHash = headHash;
          continue;
        }
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

  // Every regular file under `dir`, with its path relative to the source. Names
  // that are not UTF-8 have no path the Hub accepts, so they are skipped.
  const walk = async (source: Source, tree: string): Promise<string[] | 'unreadable'> => {
    const files: string[] = [];
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
        warnOnce(
          `${source.name}/${relative}`,
          `Could not read ${join(source.dir, relative)}: ${describeError(error)}`,
        );
        continue;
      }
      for (const raw of names) {
        const name = nameOf(raw);
        if (name === undefined) {
          const shown = join(source.dir, relative, raw.toString('utf8'));
          warnOnce(
            `${source.name}/${relative}/${raw.toString('hex')}`,
            `Skipping ${shown}: its name is not UTF-8.`,
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
            files.push(path);
          } else {
            warnOnce(
              `${source.name}/${path}`,
              `Skipping ${join(source.dir, path)}: the Hub cannot store its path.`,
            );
          }
        }
      }
    }
    return files.toSorted();
  };

  const scanSource = async (source: Source) => {
    let status = await statusOf(source);
    if (status === 'capturing') {
      for (const tree of source.trees) {
        // oxlint-disable-next-line no-await-in-loop -- one tree at a time.
        const files = await walk(source, tree);
        if (files === 'unreadable') {
          status = 'unreadable';
          continue;
        }
        for (const path of files) {
          // oxlint-disable-next-line no-await-in-loop -- one file at a time.
          await readFile(source, path, join(source.dir, path));
        }
      }
    }
    statuses.set(source.name, status);
  };

  // Starts the generation's file over and drops what it spooled, which the
  // Hub can no longer take without a gap.
  const abandon = (generation: PendingGeneration, why: string) => {
    log.warn(
      `The Hub cannot continue ${generation.source}/${generation.path} (${why}); it uploads again from the start.`,
    );
    spool.dropGeneration(generation.id);
  };

  // Brings the spool in line with the Hub holding `held` bytes of the
  // generation: removes what the Hub holds and trims a chunk it holds part of.
  // Answers false when the Hub's content no longer meets the spool's.
  const resume = async (generation: PendingGeneration, held: number) => {
    const known = Math.max(
      spool.end(generation.id) ?? 0,
      generation.current ? generation.readOffset : 0,
    );
    if (held > known) {
      abandon(generation, 'it holds more than the Collector read');
      return false;
    }
    spool.held(generation.id, held);
    const [first] = spool.chunks(generation.id, 1);
    if (first === undefined) {
      return true;
    }
    if (first.offset > held) {
      abandon(generation, 'it holds less than the Collector already sent');
      return false;
    }
    if (first.offset < held) {
      const content = await gunzip(first.body);
      const rest = content.subarray(held - first.offset);
      spool.replace({ ...first, body: await gzip(rest), length: rest.length, offset: held });
    }
    return true;
  };

  // The next request's chunks: consecutive spooled chunks within the limits.
  const nextBatch = (generation: number) => {
    const batch = [];
    let length = 0;
    let bytes = 0;
    for (const chunk of spool.chunks(generation, JOIN_CANDIDATES)) {
      const last = batch.at(-1);
      const follows = last === undefined || last.offset + last.length === chunk.offset;
      const fits =
        length + chunk.length <= chunkLimit &&
        bytes + chunk.body.length <= MAX_TRANSCRIPT_REQUEST_BYTES;
      if (last !== undefined && !(follows && fits)) {
        break;
      }
      batch.push(chunk);
      length += chunk.length;
      bytes += chunk.body.length;
    }
    return batch;
  };

  // Uploads one generation's spooled content. Answers a failure that should
  // stop this drain, or undefined when the generation is done with for now.
  const drainGeneration = async (
    pending: PendingGeneration,
  ): Promise<{ kind: 'failed'; reason: string } | undefined> => {
    let hubId = pending.hubId;
    for (;;) {
      const batch = nextBatch(pending.id);
      const first = batch[0];
      if (first === undefined) {
        spool.settle(pending.id);
        return undefined;
      }
      if (hubId === null) {
        if (first.offset !== 0) {
          abandon(pending, 'it has no record of the generation');
          return undefined;
        }
        // oxlint-disable-next-line no-await-in-loop -- one request at a time.
        const opened = await hub.open({ path: pending.path, source: pending.source });
        if (opened.kind === 'failed') {
          return opened;
        }
        if (opened.kind === 'deleted') {
          spool.refuse(pending.file);
          return undefined;
        }
        hubId = opened.generation;
        spool.setHubId(pending.id, hubId);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one request at a time.
      const answer = await hub.send({
        body: concat(batch.map((chunk) => chunk.body)),
        generation: hubId,
        offset: first.offset,
      });
      switch (answer.kind) {
        case 'held':
        case 'elsewhere': {
          // oxlint-disable-next-line no-await-in-loop -- the next request depends on it.
          if (!(await resume(pending, answer.held))) {
            return undefined;
          }
          break;
        }
        case 'deleted': {
          spool.dropGeneration(pending.id);
          return undefined;
        }
        case 'unknown': {
          hubId = null;
          spool.setHubId(pending.id, null);
          break;
        }
        case 'failed': {
          return answer;
        }
        default: {
          const _exhaustive: never = answer;
          return _exhaustive;
        }
      }
    }
  };

  return {
    // Uploads what the spool holds until it is empty or the Hub fails.
    drain: async (): Promise<DrainResult> => {
      for (const generation of spool.pending()) {
        // oxlint-disable-next-line no-await-in-loop -- one generation at a time, oldest first.
        const failure = await drainGeneration(generation);
        if (failure !== undefined) {
          return failure;
        }
      }
      return { kind: 'drained' };
    },
    // Reads every configured source, spooling what its files gained.
    scan: async () => {
      for (const source of sources) {
        // oxlint-disable-next-line no-await-in-loop -- one source at a time.
        await scanSource(source);
      }
    },
    // The Report's transcripts section: each source as of the last scan, and the spool.
    section: (): TranscriptsSection => ({
      sources: sources.map((source) => ({
        harness: source.harness,
        name: source.name,
        status: statuses.get(source.name) ?? 'capturing',
      })),
      spool: spool.summary(),
    }),
  };
};
