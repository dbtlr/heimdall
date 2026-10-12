import type { OpenGeneration } from '@heimdall/schema';
import type { SQL } from 'bun';

import { forgetDeletedGenerations, holdProjection } from './projection.ts';
import { seeSystem } from './store.ts';

export type Opened = { generation: number; kind: 'opened' } | { kind: 'deleted' };

// A random generation id from 1 to 2^53 - 1, the safe integers a Collector
// reads. Ids are random rather than sequential so a database restored from a
// backup never reissues an id it issued since: a Collector still holding one
// is told the generation is unknown and opens another, where a reissued id
// would splice two files (ADR-0013).
export const randomGenerationId = (): number => {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
  return (((high >>> 11) * 2 ** 32 + low) % (2 ** 53 - 1)) + 1;
};

// Opens a new generation of a file for `system`, which is seen at `now`,
// unless every generation already at its path was deleted on purpose
// (ADR-0013). A path with no generation, or with one surviving, opens.
// `newId` draws the generation's id, again while the one drawn is taken.
export const openGeneration = (
  sql: SQL,
  {
    newId = randomGenerationId,
    now,
    path,
    source,
    system,
  }: OpenGeneration & { newId?: () => number; now: number; system: string },
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
    for (;;) {
      const id = newId();
      // oxlint-disable-next-line no-await-in-loop -- draws again only while the id is taken.
      const opened: unknown[] = await tx`
        INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
        VALUES (${id}, ${system}, ${source}, ${path}, ${at}, ${at})
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `;
      if (opened.length > 0) {
        return { generation: id, kind: 'opened' };
      }
    }
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
    // Bun binds a number of 2^51 or more as a double, which the primary key's
    // index cannot match, so each id is cast back to bigint.
    const [row]: { deleted_at: Date | null; held: string; system: string }[] = await tx`
      SELECT system, held, deleted_at FROM transcript_generations
      WHERE id = ${generation}::bigint
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
      WHERE id = ${generation}::bigint
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

// PostgreSQL's deadlock_detected, which Bun reports in `errno`. It aborts one
// transaction of the deadlock, and nothing of it commits.
const DEADLOCK_DETECTED = '40P01';

// How many times a delete tries its transaction when PostgreSQL aborts it for
// a deadlock, and the wait after the first failure, doubling after each.
const DELETE_TRIES = 3;
const DELETE_BACKOFF_MS = 100;

const isDeadlock = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'errno' in error &&
  error.errno === DEADLOCK_DETECTED;

// Deletes whole generations on purpose, as of `now`, and answers how many it
// removed and their gzipped size; a dry run only answers. A deleted
// generation keeps its row, without its content, so its path stays refused
// once no generation there survives (ADR-0013), and the Session insight derived
// from it go in the same transaction. Refuses to run without a
// filter, so nothing deletes every transcript by omission.
// The projection's cleanup of stale parser versions can deadlock with a
// delete, and PostgreSQL then aborts one of them. A delete so aborted tries
// its transaction again, up to three tries with a short backoff, and one that
// deadlocks every time rejects with the deadlock, having deleted nothing.
// `sleep` is for tests.
export const deleteTranscripts = (
  sql: SQL,
  {
    dryRun = false,
    now,
    sleep = (ms) => Bun.sleep(ms),
    ...filter
  }: TranscriptFilter & { dryRun?: boolean; now: number; sleep?: (ms: number) => Promise<void> },
): Promise<Removed> => {
  const { source, system } = filter;
  const before = filter.before === undefined ? null : new Date(filter.before);
  if (before === null && source === undefined && system === undefined) {
    return Promise.reject(new Error('Name a System, a source, or a date to delete before.'));
  }
  return retryOnDeadlock(sleep, () => deleteOnce(sql, { before, dryRun, filter, now }));
};

const retryOnDeadlock = async <T>(
  sleep: (ms: number) => Promise<void>,
  attempt: () => Promise<T>,
): Promise<T> => {
  for (let tried = 1; ; tried += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each try follows the failure of the last.
      return await attempt();
    } catch (error) {
      if (!isDeadlock(error) || tried >= DELETE_TRIES) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- the backoff is the point.
      await sleep(DELETE_BACKOFF_MS * 2 ** (tried - 1));
    }
  }
};

// One transaction of `deleteTranscripts`.
const deleteOnce = (
  sql: SQL,
  {
    before,
    dryRun,
    filter: { source, system },
    now,
  }: { before: Date | null; dryRun: boolean; filter: TranscriptFilter; now: number },
): Promise<Removed> =>
  sql.begin(async (tx) => {
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
    // A batch the projection is storing commits first, and none starts until
    // this delete commits, so nothing derived from a deleted generation is
    // stored behind its back (ADR-0014).
    await holdProjection(tx);
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
    // Nothing derived outlives its transcript (ADR-0014).
    await forgetDeletedGenerations(tx);
    return removedOf(marked);
  });

const removedOf = (rows: Matched[]): Removed => ({
  bytes: rows.reduce((sum, row) => sum + Number(row.stored_bytes), 0),
  generations: rows.length,
});
