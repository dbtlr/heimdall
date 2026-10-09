import { MAX_TRANSCRIPT_REQUEST_BYTES } from '@heimdall/schema';

import type { TranscriptHub } from './hub-client.ts';
import type { PendingGeneration, Spool } from './spool.ts';

// How many spooled chunks one request considers joining.
const JOIN_CANDIDATES = 64;

export type DrainResult = { kind: 'drained' } | { kind: 'failed'; reason: string };

// What became of one generation's drain: done for now, stopped by a Hub that
// cannot take requests, or refused by the Hub as a request it will never take.
type Outcome =
  | { kind: 'done' }
  | { kind: 'failed'; reason: string }
  | { kind: 'refused'; reason: string };

const DONE: Outcome = { kind: 'done' };

// Uploads the spool to the Hub (docs/spec.md, "Upload protocol"), oldest
// generation first, as chunks joined into requests within the limits, and
// removes what the Hub acknowledges. A generation the Hub can no longer
// continue without a gap is dropped and its file starts over in a new one.
// `warn` is called once per run for each key.
export const createUploader = ({
  chunkLimit,
  hub,
  signal,
  spool,
  warn,
}: {
  chunkLimit: number;
  hub: TranscriptHub;
  signal?: AbortSignal | undefined;
  spool: Spool;
  warn: (key: string, message: string) => void;
}) => {
  const abandon = (generation: PendingGeneration, why: string) => {
    warn(
      `abandon ${String(generation.id)}`,
      `The Hub cannot continue ${generation.source}/${generation.path} (${why}); it uploads again from the start.`,
    );
    spool.dropGeneration(generation.id);
  };

  // Brings the spool in line with the Hub holding `held` bytes of the
  // generation. Answers false when the Hub's content no longer meets the
  // spool's: it holds more than the Collector read, or ends anywhere but at
  // the start of a spooled chunk.
  const resume = (generation: PendingGeneration, held: number) => {
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
    if (first !== undefined && first.offset !== held) {
      abandon(generation, `it holds ${String(held)} bytes, not where the spool continues`);
      return false;
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
        length + chunk.length <= chunkLimit && bytes + chunk.bytes <= MAX_TRANSCRIPT_REQUEST_BYTES;
      if (last !== undefined && !(follows && fits)) {
        break;
      }
      batch.push(chunk);
      length += chunk.length;
      bytes += chunk.bytes;
    }
    return batch;
  };

  // After the Hub deleted the generation a file still reads into, asks it
  // for a new one at the path: refused, the path was deleted on purpose and
  // stops; opened, the file uploads there from its first byte.
  const reopen = async (generation: PendingGeneration): Promise<Outcome> => {
    spool.dropGeneration(generation.id);
    if (!generation.current) {
      return DONE;
    }
    const opened = await hub.open({ path: generation.path, source: generation.source });
    switch (opened.kind) {
      case 'opened': {
        spool.adopt(generation.file, opened.generation);
        return DONE;
      }
      case 'deleted': {
        spool.refuse(generation.file);
        return DONE;
      }
      default: {
        return opened;
      }
    }
  };

  const drainGeneration = async (pending: PendingGeneration): Promise<Outcome> => {
    let hubId = pending.hubId;
    let opened = false;
    for (;;) {
      if (signal?.aborted === true) {
        return DONE;
      }
      const batch = nextBatch(pending.id);
      const first = batch[0];
      if (first === undefined) {
        spool.settle(pending.id);
        return DONE;
      }
      if (hubId === null) {
        if (first.offset !== 0) {
          abandon(pending, 'it has no record of the generation');
          return DONE;
        }
        // oxlint-disable-next-line no-await-in-loop -- one request at a time.
        const answer = await hub.open({ path: pending.path, source: pending.source });
        if (answer.kind === 'deleted') {
          spool.refuse(pending.file);
          return DONE;
        }
        if (answer.kind !== 'opened') {
          return answer;
        }
        hubId = answer.generation;
        opened = true;
        spool.setHubId(pending.id, hubId);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one request at a time.
      const answer = await hub.send({
        body: Buffer.concat(batch.map((chunk) => spool.body(chunk.id))),
        generation: hubId,
        offset: first.offset,
      });
      switch (answer.kind) {
        case 'held':
        case 'elsewhere': {
          if (!resume(pending, answer.held)) {
            return DONE;
          }
          break;
        }
        case 'deleted': {
          // oxlint-disable-next-line no-await-in-loop -- the file's next generation depends on it.
          return reopen(pending);
        }
        case 'unknown': {
          if (opened) {
            return { kind: 'failed', reason: 'Hub answered 404 for a generation it just opened' };
          }
          hubId = null;
          spool.setHubId(pending.id, null);
          break;
        }
        case 'failed':
        case 'refused': {
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
    // Uploads what the spool holds, oldest generation first, until it is
    // empty or the Hub fails. A generation whose request the Hub refuses is
    // left spooled and the others still upload; the drain then fails, so the
    // Collector backs off and tries it again.
    drain: async (): Promise<DrainResult> => {
      let refusal: string | undefined;
      for (const generation of spool.pending()) {
        // oxlint-disable-next-line no-await-in-loop -- one generation at a time, oldest first.
        const outcome = await drainGeneration(generation);
        if (outcome.kind === 'failed') {
          return outcome;
        }
        if (outcome.kind === 'refused') {
          warn(
            `refused ${String(generation.id)}`,
            `The Hub refused ${generation.source}/${generation.path} (${outcome.reason}); it stays spooled.`,
          );
          refusal ??= outcome.reason;
        }
      }
      return refusal === undefined ? { kind: 'drained' } : { kind: 'failed', reason: refusal };
    },
  };
};
