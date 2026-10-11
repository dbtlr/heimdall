import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

import type { SQL } from 'bun';

const gunzip = promisify(gunzipCallback);

// A stretch of a generation's uncompressed content from byte `from`.
// `complete` says it reaches the end of what the Hub held when asked.
export type HeldContent = { complete: boolean; content: Uint8Array };

type Row = { content: Uint8Array; length: string; offset_bytes: string };

// Reads a generation's content from byte `from` up to `held`, joining its
// chunks in offset order and unpacking each (ADR-0013). It reads about
// `limitBytes`: whole chunks until they pass the limit, so always at least
// one. A gap between chunks, or a chunk that unpacks to another length than
// it was stored with, is an error rather than content spliced wrong.
export const readHeldContent = async (
  sql: SQL,
  {
    from,
    generation,
    held,
    limitBytes,
  }: { from: number; generation: number; held: number; limitBytes: number },
): Promise<HeldContent> => {
  // Bun binds a number of 2^51 or more as a double, which the primary key's
  // index cannot match, so the id is cast back to bigint.
  const rows: Row[] = await sql`
    SELECT offset_bytes, length, content FROM transcript_chunks
    WHERE generation = ${generation}::bigint AND offset_bytes IN (
      SELECT offset_bytes FROM (
        SELECT offset_bytes, sum(length) OVER (ORDER BY offset_bytes) - length AS before
        FROM transcript_chunks
        WHERE generation = ${generation}::bigint
          AND offset_bytes + length > ${from} AND offset_bytes < ${held}
      ) AS window_of_chunks
      WHERE before < ${limitBytes}
    )
    ORDER BY offset_bytes
  `;
  const unpacked = await Promise.all(rows.map(async (row) => gunzip(row.content)));
  const pieces: Uint8Array[] = [];
  let end = from;
  for (const [i, row] of rows.entries()) {
    const offset = Number(row.offset_bytes);
    const length = Number(row.length);
    const bytes = unpacked[i];
    if (bytes?.byteLength !== length || offset > end || (i > 0 && offset !== end)) {
      throw new Error(
        `Generation ${String(generation)} has a gap or a damaged chunk at byte ${String(offset)}.`,
      );
    }
    pieces.push(bytes.subarray(end - offset));
    end = offset + length;
  }
  if (rows.length === 0 && from < held) {
    throw new Error(`Generation ${String(generation)} holds no chunk at byte ${String(from)}.`);
  }
  return { complete: end >= held, content: Buffer.concat(pieces) };
};
