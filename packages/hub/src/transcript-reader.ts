import { promisify } from 'node:util';
import { gunzip as gunzipCallback } from 'node:zlib';

import type { SQL } from 'bun';

import { MAX_LINE_BYTES } from './session-insight.ts';

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

// A transcript a reader names that the Hub cannot show: an unknown Session,
// subagent, or generation, one deleted on purpose, or an offset that starts no
// line it holds. The message says which.
export class TranscriptNotFoundError extends Error {
  override name = 'TranscriptNotFoundError';
}

// A generation the Hub holds, and how many bytes of its content.
export type HeldGeneration = { generation: number; held: number };

// Where a line is, as the insight views locate it: a generation, and
// optionally the System, source, and path it must belong to.
export type Locator = { generation: number; path?: string; source?: string; system?: string };

// The generation `locator` names, which must not be deleted.
export const locateGeneration = async (sql: SQL, locator: Locator): Promise<HeldGeneration> => {
  const { generation, path, source, system } = locator;
  const [row]: {
    deleted_at: Date | null;
    held: string;
    path: string;
    source: string;
    system: string;
  }[] = await sql`
    SELECT system, source, path, held, deleted_at FROM transcript_generations
    WHERE id = ${generation}::bigint
  `;
  if (
    row === undefined ||
    (system !== undefined && row.system !== system) ||
    (source !== undefined && row.source !== source) ||
    (path !== undefined && row.path !== path)
  ) {
    const of = [
      source === undefined ? '' : ` of ${source}`,
      system === undefined ? '' : ` on ${system}`,
      path === undefined ? '' : ` at ${path}`,
    ].join('');
    throw new TranscriptNotFoundError(`No generation ${String(generation)}${of}.`);
  }
  if (row.deleted_at !== null) {
    throw new TranscriptNotFoundError(`Generation ${String(generation)} was deleted.`);
  }
  return { generation, held: Number(row.held) };
};

// The transcript of a Session's main conversation, or of its subagent
// `agent`, as the insight views name them: the newest generation the Hub
// holds at its path that was not deleted, which is the file as it stands.
export const locateSessionTranscript = async (
  sql: SQL,
  {
    agent,
    session,
    source,
    system,
  }: { agent?: string; session: string; source: string; system: string },
): Promise<HeldGeneration> => {
  const named = `Session ${session} of ${source} on ${system}`;
  const found: { path: string | null }[] =
    agent === undefined
      ? await sql`
          SELECT path FROM insight.sessions
          WHERE system = ${system} AND source = ${source} AND session_id = ${session}
        `
      : await sql`
          SELECT path FROM insight.subagents
          WHERE system = ${system} AND source = ${source} AND session_id = ${session}
            AND agent_id = ${agent}
        `;
  if (found.length === 0) {
    throw new TranscriptNotFoundError(
      agent === undefined
        ? `No ${named} is in the insight views.`
        : `No subagent ${agent} of ${named} is in the insight views.`,
    );
  }
  const path = found[0]?.path ?? null;
  if (path === null) {
    throw new TranscriptNotFoundError(
      agent === undefined
        ? `The Hub holds no main transcript of ${named}, only its subagents'.`
        : `The Hub holds no transcript of subagent ${agent} of ${named}.`,
    );
  }
  const [newest]: { held: string; id: string }[] = await sql`
    SELECT id, held FROM transcript_generations
    WHERE system = ${system} AND source = ${source} AND md5(path) = md5(${path}) AND path = ${path}
      AND deleted_at IS NULL
    ORDER BY opened_at DESC, last_upload_at DESC
    LIMIT 1
  `;
  if (newest === undefined) {
    throw new TranscriptNotFoundError(`Every generation of ${path} was deleted.`);
  }
  return { generation: Number(newest.id), held: Number(newest.held) };
};

// How much content a show reads at once.
const SHOW_WINDOW_BYTES = 4 * 2 ** 20;

// A show counts no budget, so it ignores what each read fetched.
const fetched = () => {};

// The byte that ends a line, `\n`.
const NEWLINE = 10;

// Writes a generation's content from byte `from`, which must start a line,
// to `write` a window at a time: to the end of what it holds, or with
// `oneLine` through the end of the line at `from`.
export const writeHeldLines = async (
  sql: SQL,
  {
    from,
    generation,
    held,
    oneLine,
    windowBytes = SHOW_WINDOW_BYTES,
  }: HeldGeneration & { from: number; oneLine: boolean; windowBytes?: number },
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<void> => {
  if ((from > 0 || oneLine) && from >= held) {
    throw new TranscriptNotFoundError(
      `Generation ${String(generation)} holds ${String(held)} bytes, so byte ${String(from)} is past its end.`,
    );
  }
  if (from > 0) {
    const before = await readHeldContent(sql, {
      fetched,
      from: from - 1,
      generation,
      held,
      limitBytes: 1,
    });
    if (before.content[0] !== NEWLINE) {
      throw new TranscriptNotFoundError(
        `Byte ${String(from)} of generation ${String(generation)} does not start a line.`,
      );
    }
  }
  let next = from;
  while (next < held) {
    // oxlint-disable-next-line no-await-in-loop -- a window at a time bounds memory.
    const { content } = await readHeldContent(sql, {
      fetched,
      from: next,
      generation,
      held,
      limitBytes: windowBytes,
    });
    if (content.byteLength === 0) {
      return;
    }
    const end = oneLine ? content.indexOf(NEWLINE) : -1;
    if (end !== -1) {
      // oxlint-disable-next-line no-await-in-loop -- the last write.
      await write(content.subarray(0, end + 1));
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- in order, as held.
    await write(content);
    next += content.byteLength;
  }
};

// A request as the insight views hold it: its Harness, and the generations
// that hold its lines, the one its locator names first.
export type HeldRequest = { generations: HeldGeneration[]; harness: string };

// The request `request` of `source` on `system`, from the insight views, and
// every generation that holds it: the one its locator names, and any other
// that holds it too, which the projection notes in `projected_holders`. A
// deleted generation is left out.
export const locateRequest = async (
  sql: SQL,
  { request, source, system }: { request: string; source: string; system: string },
): Promise<HeldRequest> => {
  const [found]: { generation: string; harness: string; parser_version: number }[] = await sql`
    SELECT harness, generation, parser_version FROM insight.requests
    WHERE system = ${system} AND source = ${source} AND request_id = ${request}
  `;
  if (found === undefined) {
    throw new TranscriptNotFoundError(
      `No request ${request} of ${source} on ${system} is in the insight views.`,
    );
  }
  const generations: { held: string; id: string }[] = await sql`
    SELECT g.id, g.held FROM transcript_generations g
    WHERE g.deleted_at IS NULL AND (
      g.id = ${found.generation}::bigint OR g.id IN (
        SELECT h.generation FROM projected_holders h
        WHERE h.harness = ${found.harness} AND h.parser_version = ${found.parser_version}
          AND h.system = ${system} AND h.source = ${source} AND h.fact_id = ${request}
      )
    )
    ORDER BY g.id = ${found.generation}::bigint DESC, g.opened_at
  `;
  return {
    generations: generations.map((row) => ({ generation: Number(row.id), held: Number(row.held) })),
    harness: found.harness,
  };
};

const lineDecoder = new TextDecoder();

// Joins the pieces of one line.
const joined = (pieces: Uint8Array[]) => {
  const line = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.byteLength, 0));
  let at = 0;
  for (const piece of pieces) {
    line.set(piece, at);
    at += piece.byteLength;
  }
  return line;
};

// Calls `each` with every whole line of a generation's content, its newline
// included, and the last line without one. A line longer than
// `MAX_LINE_BYTES` is skipped as it is read, never held whole, as the parsers
// skip it.
const eachLine = async (
  sql: SQL,
  { generation, held, windowBytes }: HeldGeneration & { windowBytes: number },
  each: (line: Uint8Array) => Promise<void>,
) => {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let skipping = false;
  let from = 0;
  while (from < held) {
    // oxlint-disable-next-line no-await-in-loop -- a window at a time bounds memory.
    const { content } = await readHeldContent(sql, {
      fetched,
      from,
      generation,
      held,
      limitBytes: windowBytes,
    });
    if (content.byteLength === 0) {
      break;
    }
    let start = 0;
    let end = content.indexOf(NEWLINE, start);
    while (end !== -1) {
      // A line can cross windows, so its length counts what is pending, and
      // excludes its newline, as the parsers' limit does.
      if (!skipping && pendingBytes + (end - start) <= MAX_LINE_BYTES) {
        // oxlint-disable-next-line no-await-in-loop -- one line at a time, in order.
        await each(joined([...pending, content.subarray(start, end + 1)]));
      }
      pending = [];
      pendingBytes = 0;
      skipping = false;
      start = end + 1;
      end = content.indexOf(NEWLINE, start);
    }
    const rest = content.subarray(start);
    pendingBytes += rest.byteLength;
    if (pendingBytes > MAX_LINE_BYTES) {
      skipping = true;
      pending = [];
    } else if (!skipping) {
      // A copy, so the window it came from can be let go.
      pending.push(Uint8Array.from(rest));
    }
    from += content.byteLength;
  }
  if (!skipping && pendingBytes > 0) {
    await each(joined(pending));
  }
};

// Writes to `write` every line of `generations` that `requestIdOf` names as
// request `request`'s, generation by generation in the order given, and a line
// that several generations hold only once.
export const writeRequestLines = async (
  sql: SQL,
  {
    generations,
    request,
    requestIdOf,
    windowBytes = SHOW_WINDOW_BYTES,
  }: {
    generations: readonly HeldGeneration[];
    request: string;
    requestIdOf: (line: unknown) => string | null;
    windowBytes?: number;
  },
  write: (bytes: Uint8Array) => Promise<void>,
): Promise<void> => {
  const written = new Set<string>();
  for (const held of generations) {
    // oxlint-disable-next-line no-await-in-loop -- one generation at a time, in order.
    await eachLine(sql, { ...held, windowBytes }, async (line) => {
      const text = lineDecoder.decode(line);
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return;
      }
      const key = text.endsWith('\n') ? text : `${text}\n`;
      if (requestIdOf(value) === request && !written.has(key)) {
        written.add(key);
        await write(line);
      }
    });
  }
};
