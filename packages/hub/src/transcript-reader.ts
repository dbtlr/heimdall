import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

import type { SQL } from 'bun';

const gunzip = promisify(gunzipCallback);

// A generation whose chunks cannot yield its content: a gap between them, or a
// chunk that does not unpack to the length it was stored with. Reading again
// cannot help, so the projection records the generation failed.
export class UnreadableGenerationError extends Error {
  override name = 'UnreadableGenerationError';
}

const unpack = async (generation: number, offset: string, content: Uint8Array) => {
  try {
    return await gunzip(content);
  } catch {
    throw new UnreadableGenerationError(
      `Generation ${String(generation)} has a chunk at byte ${offset} that does not unpack.`,
    );
  }
};

// A stretch of a generation's uncompressed content from byte `from`.
// `complete` says it reaches the end of what the Hub held when asked.
export type HeldContent = { complete: boolean; content: Uint8Array };

type Row = { content: Uint8Array; length: string; offset_bytes: string };

// How many chunks one query fetches at most, so a read holds no more than
// that many packed chunks at once beside its answer.
const CHUNKS_PER_FETCH = 2;

// Reads a generation's content from byte `from` up to `held`, joining its
// chunks in offset order and unpacking each (ADR-0013). It answers at most
// `limitBytes`, reading only the chunks that hold them, fetching them
// `CHUNKS_PER_FETCH` at a time and unpacking one at a time into the answer,
// so it holds no more than the answer, two packed chunks, and one unpacked.
// It tells `fetched` the uncompressed length of every chunk it fetches as it
// fetches it, before anything can fail: whole chunks, so up to a chunk more
// than it answers at each end. A gap between chunks, or a chunk that unpacks
// to another length than it was stored with, is an error rather than content
// spliced wrong.
export const readHeldContent = async (
  sql: SQL,
  {
    fetched,
    from,
    generation,
    held,
    limitBytes,
  }: {
    fetched: (bytes: number) => void;
    from: number;
    generation: number;
    held: number;
    limitBytes: number;
  },
): Promise<HeldContent> => {
  const until = Math.min(held, from + limitBytes);
  const content = new Uint8Array(Math.max(0, until - from));
  // Where the chunks read so far end, and the offset of the last of them.
  let end = from;
  let last: number | undefined;
  while (end < until) {
    // oxlint-disable-next-line no-await-in-loop -- a few chunks at a time bounds memory.
    const rows = await chunksAfter(sql, { after: last, from, generation, until });
    fetched(rows.reduce((sum, row) => sum + Number(row.length), 0));
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      const offset = Number(row.offset_bytes);
      if (offset > end || (last !== undefined && offset !== end)) {
        throw new UnreadableGenerationError(
          `Generation ${String(generation)} has a gap or a damaged chunk at byte ${String(offset)}.`,
        );
      }
      // oxlint-disable-next-line no-await-in-loop -- one chunk unpacked at a time bounds memory.
      const bytes = await unpack(generation, row.offset_bytes, row.content);
      if (bytes.byteLength !== Number(row.length)) {
        throw new UnreadableGenerationError(
          `Generation ${String(generation)} has a gap or a damaged chunk at byte ${String(offset)}.`,
        );
      }
      const start = Math.max(from, offset);
      content.set(
        bytes.subarray(start - offset, Math.min(bytes.byteLength, until - offset)),
        start - from,
      );
      end = offset + bytes.byteLength;
      last = offset;
    }
  }
  if (last === undefined && from < until) {
    throw new UnreadableGenerationError(
      `Generation ${String(generation)} holds no chunk at byte ${String(from)}.`,
    );
  }
  const answered = Math.max(0, Math.min(end, until) - from);
  return { complete: from + answered >= held, content: content.subarray(0, answered) };
};

// The next chunks a read needs, in offset order: from the one that holds
// byte `from`, or after the one at offset `after`, up to byte `until`. Bun
// binds a number of 2^51 or more as a double, which the primary key's index
// cannot match, so the id is cast back to bigint.
const chunksAfter = (
  sql: SQL,
  {
    after,
    from,
    generation,
    until,
  }: { after: number | undefined; from: number; generation: number; until: number },
): Promise<Row[]> =>
  after === undefined
    ? sql`
        SELECT offset_bytes, length, content FROM transcript_chunks
        WHERE generation = ${generation}::bigint
          AND offset_bytes + length > ${from} AND offset_bytes < ${until}
        ORDER BY offset_bytes LIMIT ${CHUNKS_PER_FETCH}
      `
    : sql`
        SELECT offset_bytes, length, content FROM transcript_chunks
        WHERE generation = ${generation}::bigint
          AND offset_bytes > ${after} AND offset_bytes < ${until}
        ORDER BY offset_bytes LIMIT ${CHUNKS_PER_FETCH}
      `;
