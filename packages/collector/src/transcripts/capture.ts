import { MAX_TRANSCRIPT_CHUNK_BYTES } from '@heimdall/schema';
import type { TranscriptsSection } from '@heimdall/schema';

import type { TranscriptHub } from './hub-client.ts';
import { createReader, statusOf } from './reader.ts';
import type { SourceStatus } from './reader.ts';
import type { Source } from './sources.ts';
import type { Spool } from './spool.ts';
import { createUploader } from './uploader.ts';

export type { DrainResult } from './uploader.ts';

// Captures the transcripts of `sources` into `spool` and drains the spool to
// `hub` (ADR-0013). `scan` reads what each source's files gained since the
// last scan; `drain` uploads what the spool holds, including what sources no
// longer configured left behind. `section` is the Report's transcripts
// section. Both stop early once `signal` aborts.
export const createCapture = ({
  chunkLimit = MAX_TRANSCRIPT_CHUNK_BYTES,
  hub,
  log,
  now,
  readBytes,
  signal,
  sources,
  spool,
}: {
  chunkLimit?: number | undefined;
  hub: TranscriptHub;
  log: { warn: (message: string) => unknown };
  now: () => number;
  readBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  sources: readonly Source[];
  spool: Spool;
}) => {
  const statuses = new Map<string, SourceStatus>();
  // Warn about each unusable path or generation once per run, not once a scan.
  const warned = new Set<string>();
  const warn = (key: string, message: string) => {
    if (!warned.has(key)) {
      warned.add(key);
      log.warn(message);
    }
  };
  const reader = createReader({
    chunkLimit,
    now,
    ...(readBytes === undefined ? {} : { readBytes }),
    signal,
    spool,
    warn,
  });
  const uploader = createUploader({ chunkLimit, hub, signal, spool, warn });

  return {
    drain: uploader.drain,
    // Reads every configured source, spooling what its files gained. Every
    // source's status is known before the first is read, so a long first
    // read of a source's history never reports another source wrongly.
    scan: async () => {
      const found = await Promise.all(sources.map((source) => statusOf(source)));
      for (const [index, source] of sources.entries()) {
        statuses.set(source.name, found[index] ?? 'unreadable');
      }
      for (const source of sources) {
        if (statuses.get(source.name) === 'capturing') {
          // oxlint-disable-next-line no-await-in-loop -- one source at a time.
          statuses.set(source.name, await reader.readSource(source));
        }
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
