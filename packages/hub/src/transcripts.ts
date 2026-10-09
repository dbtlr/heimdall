import type { OpenGeneration } from '@heimdall/schema';
import type { SQL } from 'bun';

import { seeSystem } from './store.ts';

export type Opened = { generation: number; kind: 'opened' } | { kind: 'deleted' };

// Opens a new generation of a file for `system`, which is seen at `now`,
// unless every generation already at its path was deleted on purpose
// (ADR-0013). A path with no generation, or with one surviving, opens.
export const openGeneration = (
  sql: SQL,
  { now, path, source, system }: OpenGeneration & { now: number; system: string },
): Promise<Opened> =>
  sql.begin(async (tx) => {
    await seeSystem(tx, { at: now, system });
    const [existing]: { live: string; total: string }[] = await tx`
      SELECT count(*) AS total, count(*) FILTER (WHERE deleted_at IS NULL) AS live
      FROM transcript_generations
      WHERE system = ${system} AND source = ${source} AND path = ${path}
    `;
    if (existing !== undefined && Number(existing.total) > 0 && Number(existing.live) === 0) {
      return { kind: 'deleted' };
    }
    const at = new Date(now);
    const [opened]: { id: string }[] = await tx`
      INSERT INTO transcript_generations (system, source, path, opened_at, last_upload_at)
      VALUES (${system}, ${source}, ${path}, ${at}, ${at})
      RETURNING id
    `;
    return { generation: Number(opened?.id), kind: 'opened' };
  });

// One chunk of a generation's content: `content` is gzipped, as uploaded, and
// unpacks to `length` bytes of the file, starting at `offset`.
export type Chunk = {
  content: Uint8Array;
  generation: number;
  length: number;
  now: number;
  offset: number;
  system: string;
};

export type Appended =
  | { held: number; kind: 'held' }
  | { held: number; kind: 'mismatch' }
  | { kind: 'deleted' }
  | { kind: 'unknown' };

// Stores a chunk at the offset the Hub holds for its generation and answers
// the new total, in one transaction, so what the Hub acknowledges it holds
// (ADR-0013). A chunk the Hub holds already changes nothing; one at any other
// offset is answered with what the Hub holds. A generation `system` did not
// open is unknown, and one deleted on purpose refuses chunks. The System is
// seen at `now` whatever the answer.
export const appendChunk = (
  sql: SQL,
  { content, generation, length, now, offset, system }: Chunk,
): Promise<Appended> =>
  sql.begin(async (tx) => {
    await seeSystem(tx, { at: now, system });
    // The row lock orders chunks of one generation, so two deliveries of a
    // chunk cannot both append it.
    const [row]: { deleted_at: Date | null; held: string; system: string }[] = await tx`
      SELECT system, held, deleted_at FROM transcript_generations
      WHERE id = ${generation}
      FOR UPDATE
    `;
    if (row === undefined || row.system !== system) {
      return { kind: 'unknown' };
    }
    if (row.deleted_at !== null) {
      return { kind: 'deleted' };
    }
    const held = Number(row.held);
    if (offset < held && offset + length <= held) {
      return { held, kind: 'held' };
    }
    if (offset !== held) {
      return { held, kind: 'mismatch' };
    }
    if (length === 0) {
      return { held, kind: 'held' };
    }
    await tx`
      INSERT INTO transcript_chunks (generation, offset_bytes, length, content)
      VALUES (${generation}, ${offset}, ${length}, ${content})
    `;
    await tx`
      UPDATE transcript_generations SET
        held = held + ${length},
        stored_bytes = stored_bytes + ${content.byteLength},
        last_upload_at = GREATEST(last_upload_at, ${new Date(now)})
      WHERE id = ${generation}
    `;
    return { held: held + length, kind: 'held' };
  });

// Which generations a delete removes: those matching every filter given.
// `before` compares each generation's last upload, in epoch milliseconds.
export type TranscriptFilter = { before?: number; source?: string; system?: string };

export type Removed = { bytes: number; generations: number };

// A delete of years of transcripts can outlast the usual statement timeout.
const DELETE_TIMEOUT = '10min';

// Deletes whole generations on purpose, as of `now`, and answers how many it
// removed and their gzipped size; a dry run only answers. A deleted
// generation keeps its row, without its content, so its path stays refused
// once no generation there survives (ADR-0013). Refuses to run without a
// filter, so nothing deletes every transcript by omission.
export const deleteTranscripts = (
  sql: SQL,
  { dryRun = false, now, ...filter }: TranscriptFilter & { dryRun?: boolean; now: number },
): Promise<Removed> => {
  const { before, source, system } = filter;
  if (before === undefined && source === undefined && system === undefined) {
    return Promise.reject(new Error('Name a System, a source, or a date to delete before.'));
  }
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${DELETE_TIMEOUT}'`);
    const matched: { id: string; stored_bytes: string }[] = await tx`
      SELECT id, stored_bytes FROM transcript_generations
      WHERE deleted_at IS NULL
        AND (${system ?? null}::text IS NULL OR system = ${system ?? null})
        AND (${source ?? null}::text IS NULL OR source = ${source ?? null})
        AND (${before === undefined ? null : new Date(before)}::timestamptz IS NULL
             OR last_upload_at < ${before === undefined ? null : new Date(before)})
      FOR UPDATE
    `;
    const ids = matched.map((row) => row.id);
    if (!dryRun && ids.length > 0) {
      await tx`DELETE FROM transcript_chunks WHERE generation IN ${tx(ids)}`;
      await tx`
        UPDATE transcript_generations SET deleted_at = ${new Date(now)}
        WHERE id IN ${tx(ids)}
      `;
    }
    return {
      bytes: matched.reduce((sum, row) => sum + Number(row.stored_bytes), 0),
      generations: matched.length,
    };
  });
};
