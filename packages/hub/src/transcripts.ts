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
    // Locking the path's generations waits out a delete that is marking them,
    // then reads them as it left them, so a path it refused stays refused.
    // Generation rows lock before the System's row everywhere, so uploads
    // cannot deadlock.
    const existing: { deleted_at: Date | null }[] = await tx`
      SELECT deleted_at FROM transcript_generations
      WHERE system = ${system} AND source = ${source} AND md5(path) = md5(${path}) AND path = ${path}
      ORDER BY id
      FOR UPDATE
    `;
    await seeSystem(tx, { at: now, system });
    if (existing.length > 0 && existing.every((row) => row.deleted_at !== null)) {
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
    // The generation's row lock orders its chunks, so two deliveries of a
    // chunk cannot both append it. It is taken before the System's row, so a
    // delete holding the generation does not hold up the System's Reports.
    const [row]: { deleted_at: Date | null; held: string; system: string }[] = await tx`
      SELECT system, held, deleted_at FROM transcript_generations
      WHERE id = ${generation}
      FOR UPDATE
    `;
    await seeSystem(tx, { at: now, system });
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

type Matched = { id: string; stored_bytes: string };

// Deletes whole generations on purpose, as of `now`, and answers how many it
// removed and their gzipped size; a dry run only answers. A deleted
// generation keeps its row, without its content, so its path stays refused
// once no generation there survives (ADR-0013). Refuses to run without a
// filter, so nothing deletes every transcript by omission.
export const deleteTranscripts = (
  sql: SQL,
  { dryRun = false, now, ...filter }: TranscriptFilter & { dryRun?: boolean; now: number },
): Promise<Removed> => {
  const { source, system } = filter;
  const before = filter.before === undefined ? null : new Date(filter.before);
  if (before === null && source === undefined && system === undefined) {
    return Promise.reject(new Error('Name a System, a source, or a date to delete before.'));
  }
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${DELETE_TIMEOUT}'`);
    const matching = tx`
      deleted_at IS NULL
      AND (${system ?? null}::text IS NULL OR system = ${system ?? null})
      AND (${source ?? null}::text IS NULL OR source = ${source ?? null})
      AND (${before}::timestamptz IS NULL OR last_upload_at < ${before})
    `;
    if (dryRun) {
      return removedOf(
        await tx`SELECT id, stored_bytes FROM transcript_generations WHERE ${matching}`,
      );
    }
    // Marking takes each generation's row lock, which an open at its path
    // waits for. Locks are taken in id order, as an open takes them, so the
    // two cannot deadlock. A generation opened while a pass ran is not in that
    // pass's snapshot, so passes repeat until one finds nothing. Each pass
    // removes its generations' chunks in the same statement, so no list of
    // generations, however long, is sent back as parameters.
    const marked: Matched[] = [];
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- each pass sees what the last one missed.
      const pass: Matched[] = await tx`
        WITH marked AS (
          UPDATE transcript_generations SET deleted_at = ${new Date(now)}
          WHERE id IN (
            SELECT id FROM transcript_generations WHERE ${matching} ORDER BY id FOR UPDATE
          )
          RETURNING id, stored_bytes
        ),
        removed AS (
          DELETE FROM transcript_chunks WHERE generation IN (SELECT id FROM marked)
        )
        SELECT id, stored_bytes FROM marked
      `;
      if (pass.length === 0) {
        break;
      }
      marked.push(...pass);
    }
    return removedOf(marked);
  });
};

const removedOf = (rows: Matched[]): Removed => ({
  bytes: rows.reduce((sum, row) => sum + Number(row.stored_bytes), 0),
  generations: rows.length,
});
