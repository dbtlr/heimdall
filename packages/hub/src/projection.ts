import type { SQL } from 'bun';

import { claudeCodeParser } from './claude-code-parser.ts';
import { MAX_LINE_BYTES } from './session-insight.ts';
import type { Batch, HarnessParser } from './session-insight.ts';
import { storable, storableJson } from './storable.ts';
import { readHeldContent, UnreadableGenerationError } from './transcript-reader.ts';

// The parsers the Hub runs, one per Harness it derives Session insight for.
export const PARSERS: readonly HarnessParser[] = [claudeCodeParser];

// How much transcript content one run parses at most, across generations. A
// run reads whole chunks, so it can pass the budget by up to a chunk, and by
// more for a line longer than the budget, which it reads whole up to
// `MAX_LINE_BYTES`.
export const PARSE_BUDGET_BYTES = 64 * 2 ** 20;

// How many generations one run considers at most.
const GENERATIONS_PER_RUN = 1000;

// How many rows of an earlier parser version one run deletes from each table
// at most, so no statement holds its locks for long.
const CLEANUP_ROWS = 10_000;

// What a run left: generations not yet parsed through what the Hub holds;
// each generation it recorded failed, and why; each Harness whose views it
// switched to a newly complete parser version; and each Harness it left alone
// because its current version is newer than the Hub's parser.
export type Projected = {
  failed: { error: string; generation: number; harness: string }[];
  outdated: { current: number; harness: string; version: number }[];
  pending: number;
  switched: { harness: string; version: number }[];
};

type Pending = {
  held: string;
  id: string;
  parsed_through: string | null;
  path: string;
  skipping_line: boolean | null;
  source: string;
  system: string;
};

type Options = {
  budgetBytes?: number;
  // How many rows of an earlier version one run deletes from each table at most.
  cleanupRows?: number;
  parsers?: readonly HarnessParser[];
};

// Parses what the archive holds and the Hub's parser version has not read yet,
// then switches each Harness whose rebuild has caught up (ADR-0014). Each
// generation's batch commits with its progress, so a run that stops, or a Hub
// that restarts, loses nothing and resumes from the progress. A parser whose
// version is not current writes beside the current one, which the `insight`
// views keep showing until the new version has caught up; then the views
// switch in one statement, and later runs delete the earlier version's rows.
// Versions only move forward: a Hub whose parser is older than its Harness's
// current version leaves that Harness alone.
export const projectTranscripts = async (
  sql: SQL,
  { budgetBytes = PARSE_BUDGET_BYTES, cleanupRows = CLEANUP_ROWS, parsers = PARSERS }: Options = {},
): Promise<Projected> => {
  const projected: Projected = { failed: [], outdated: [], pending: 0, switched: [] };
  let budget = budgetBytes;
  for (const parser of parsers) {
    // oxlint-disable-next-line no-await-in-loop -- one Harness at a time.
    const current = await currentVersion(sql, parser.harness);
    if (current !== undefined && current > parser.version) {
      projected.outdated.push({ current, harness: parser.harness, version: parser.version });
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- the budget is shared, so in turn.
    budget -= await parsePending(sql, { budget, failed: projected.failed, parser });
    // oxlint-disable-next-line no-await-in-loop -- one Harness at a time.
    projected.pending += await pendingCount(sql, parser);
    // oxlint-disable-next-line no-await-in-loop -- one Harness at a time.
    if (current !== parser.version && (await switchVersion(sql, parser))) {
      projected.switched.push({ harness: parser.harness, version: parser.version });
    }
    // oxlint-disable-next-line no-await-in-loop -- one Harness at a time.
    await showRederived(sql, parser.harness);
    // oxlint-disable-next-line no-await-in-loop -- one Harness at a time.
    await dropEarlierVersions(sql, { harness: parser.harness, rows: cleanupRows });
  }
  return projected;
};

// The lines `serve` logs of a run: each switch, each generation recorded
// failed, and each Harness left alone for a newer parser version, once per
// version pair, since every run would repeat it. `logged` remembers which
// pairs were logged.
export const projectionNotes = (
  { failed, outdated, switched }: Projected,
  logged: Set<string>,
): { level: 'info' | 'warn'; text: string }[] => [
  ...switched.map(({ harness, version }) => ({
    level: 'info' as const,
    text: `Session insight for ${harness} now reads parser version ${String(version)}.`,
  })),
  ...failed.map(({ error, generation, harness }) => ({
    level: 'warn' as const,
    text: `Could not parse generation ${String(generation)} for ${harness}, so it waits for the next parser version: ${error}`,
  })),
  ...outdated.flatMap(({ current, harness, version }) => {
    const key = `${harness}:${String(current)}:${String(version)}`;
    if (logged.has(key)) {
      return [];
    }
    logged.add(key);
    return [
      {
        level: 'warn' as const,
        text: `Session insight for ${harness} is at parser version ${String(current)}, newer than this Hub's ${String(version)}, so this Hub leaves it alone until it is upgraded.`,
      },
    ];
  }),
];

const currentVersion = async (sql: SQL, harness: string) => {
  const [row]: { version: number }[] = await sql`
    SELECT version FROM current_parsers WHERE harness = ${harness}
  `;
  return row?.version;
};

// Parses the generations `parser` has not read through what the Hub holds,
// within `budget` bytes, and answers the bytes it read. A generation that
// cannot be parsed is recorded failed, and added to `failed`.
const parsePending = async (
  sql: SQL,
  {
    budget,
    failed,
    parser,
  }: { budget: number; failed: Projected['failed']; parser: HarnessParser },
) => {
  let left = budget;
  const work = await pendingGenerations(sql, parser);
  for (const generation of work) {
    if (left <= 0) {
      break;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- the budget is shared, so in turn.
      left -= await parseGeneration(sql, parser, generation, left);
    } catch (error) {
      if (!isPermanent(error)) {
        throw error;
      }
      // oxlint-disable-next-line no-await-in-loop -- recorded before the next generation.
      await recordFailure(sql, { error, parser, row: generation });
      failed.push({
        error: describe(error),
        generation: Number(generation.id),
        harness: parser.harness,
      });
    }
  }
  return budget - left;
};

// PostgreSQL's classes of error that storing the same values again repeats:
// data exceptions, integrity violations, and program limits, such as an index
// row too large. Other errors, such as a lost connection, pass with time.
const PERMANENT_CLASSES = new Set(['22', '23', '54']);

// Whether parsing the generation again would fail the same way: it cannot be
// read, or the database refuses what it yields.
const isPermanent = (error: unknown): boolean =>
  error instanceof UnreadableGenerationError ||
  (typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    typeof error.errno === 'string' &&
    PERMANENT_CLASSES.has(error.errno.slice(0, 2)));

// How much of a failure's message is kept: enough to say what went wrong.
const FAILURE_LENGTH = 500;

const describe = (error: unknown) =>
  storable((error instanceof Error ? error.message : String(error)).slice(0, FAILURE_LENGTH));

// Records a generation as failed for `parser`'s version, so it stops counting
// as pending and the rest of the archive proceeds. The next parser version
// parses it again. Under the same compare-and-set as a batch's progress.
const recordFailure = async (
  sql: SQL,
  { error, parser, row }: { error: unknown; parser: HarnessParser; row: Pending },
) => {
  const failure = describe(error);
  await sql.begin(async (tx) => {
    if (!(await shareProjection(tx))) {
      return;
    }
    await (row.parsed_through === null
      ? tx`
        INSERT INTO parse_progress (
          harness, parser_version, generation, parsed_through, held_seen, failed_at, failure
        )
        SELECT ${parser.harness}, ${parser.version}, ${row.id}::bigint, 0, 0, now(), ${failure}
        WHERE EXISTS (
          SELECT 1 FROM transcript_generations WHERE id = ${row.id}::bigint AND deleted_at IS NULL
        )
        ON CONFLICT DO NOTHING
      `
      : tx`
        UPDATE parse_progress SET failed_at = now(), failure = ${failure}
        WHERE harness = ${parser.harness} AND parser_version = ${parser.version}
          AND generation = ${row.id}::bigint AND parsed_through = ${Number(row.parsed_through)}
      `);
  });
};

// Generations of `parser`'s Harness that its version has not read through what
// the Hub holds, oldest upload first. A source runs the Harness its System's
// Reports named for it.
const pendingGenerations = (sql: SQL, parser: HarnessParser): Promise<Pending[]> => sql`
  SELECT g.id, g.system, g.source, g.path, g.held, p.parsed_through, p.skipping_line
  FROM transcript_generations g
  JOIN transcript_source_harnesses h ON h.system = g.system AND h.source = g.source
  LEFT JOIN parse_progress p
    ON p.harness = h.harness AND p.parser_version = ${parser.version} AND p.generation = g.id
  WHERE h.harness = ${parser.harness} AND g.deleted_at IS NULL
    AND (p.generation IS NULL OR (p.failed_at IS NULL AND p.held_seen < g.held))
  ORDER BY g.last_upload_at, g.id
  LIMIT ${GENERATIONS_PER_RUN}
`;

const pendingCount = async (sql: SQL, parser: HarnessParser) => {
  const [row]: { n: number }[] = await sql`
    SELECT count(*)::int AS n
    FROM transcript_generations g
    JOIN transcript_source_harnesses h ON h.system = g.system AND h.source = g.source
    LEFT JOIN parse_progress p
      ON p.harness = h.harness AND p.parser_version = ${parser.version} AND p.generation = g.id
    WHERE h.harness = ${parser.harness} AND g.deleted_at IS NULL
      AND (p.generation IS NULL OR (p.failed_at IS NULL AND p.held_seen < g.held))
  `;
  return row?.n ?? 0;
};

// Parses one batch of a generation from where its progress stopped, within
// `budget` bytes, and answers the bytes it read. A file the parser does not
// read is marked parsed through what the Hub holds, unread. A line longer
// than the budget is read by doubling what is read, up to `MAX_LINE_BYTES`;
// a line longer than that is counted unreadable and skipped as it is read,
// so it is never held whole.
const parseGeneration = async (
  sql: SQL,
  parser: HarnessParser,
  row: Pending,
  budget: number,
): Promise<number> => {
  const generation = { ...row, held: Number(row.held), id: Number(row.id) };
  const from = row.parsed_through === null ? 0 : Number(row.parsed_through);
  const store = (batch: Batch, { read, skipping }: { read: Read; skipping: boolean }) =>
    storeBatch(sql, {
      batch,
      expected: row.parsed_through,
      generation,
      // Content read only in part stays pending for the next run.
      heldSeen: read.complete ? generation.held : from + read.content.byteLength,
      parser,
      skipping,
    });
  if (!parser.reads(row.path)) {
    await store(
      { ...EMPTY, parsedThrough: generation.held },
      { read: { complete: true, content: new Uint8Array() }, skipping: false },
    );
    return 0;
  }
  for (let limit = budget; ; limit *= 2) {
    // oxlint-disable-next-line no-await-in-loop -- reads more only when a line did not fit.
    const read = await readHeldContent(sql, {
      from,
      generation: generation.id,
      held: generation.held,
      limitBytes: limit,
    });
    const { complete, content } = read;
    if (row.skipping_line === true) {
      // oxlint-disable-next-line no-await-in-loop -- the loop ends here.
      await skipOverlongLine(parser, { from, path: row.path, read, store });
      return content.byteLength;
    }
    const batch = parser.parse({ complete, content, offset: from, path: row.path });
    if (batch.parsedThrough > from || content.byteLength > MAX_LINE_BYTES || complete) {
      const overlong = batch.parsedThrough === from && content.byteLength > MAX_LINE_BYTES;
      // oxlint-disable-next-line no-await-in-loop -- the loop ends here.
      await store(
        overlong
          ? {
              ...EMPTY,
              owner: batch.owner,
              parsedThrough: from + content.byteLength,
              unreadableLines: 1,
            }
          : batch,
        { read, skipping: overlong },
      );
      return content.byteLength;
    }
    // A read as large as the whole generation that still stops short of
    // `held` means its chunks do.
    if (limit > generation.held) {
      throw new UnreadableGenerationError(
        `Generation ${row.id} holds no chunk past byte ${String(from + content.byteLength)}.`,
      );
    }
  }
};

type Read = Awaited<ReturnType<typeof readHeldContent>>;

const NEWLINE = '\n'.charCodeAt(0);

// Reads on from inside a line too long to read, already counted unreadable:
// past its newline, if this read holds it, and parses what follows.
const skipOverlongLine = async (
  parser: HarnessParser,
  {
    from,
    path,
    read,
    store,
  }: {
    from: number;
    path: string;
    read: Read;
    store: (batch: Batch, how: { read: Read; skipping: boolean }) => Promise<void>;
  },
) => {
  const { complete, content } = read;
  const end = content.indexOf(NEWLINE);
  if (end === -1) {
    await store({ ...EMPTY, parsedThrough: from + content.byteLength }, { read, skipping: true });
    return;
  }
  const batch = parser.parse({
    complete,
    content: content.subarray(end + 1),
    offset: from + end + 1,
    path,
  });
  await store(batch, { read, skipping: false });
};

const EMPTY: Batch = {
  agent: null,
  owner: null,
  parsedThrough: 0,
  requests: [],
  span: null,
  toolCalls: [],
  transcript: false,
  unreadableLines: 0,
};

type Generation = { held: number; id: number; path: string; source: string; system: string };

// Serializes the projection's writes with deleting transcripts. Every write
// holds it shared for its transaction, and a delete holds it alone for its
// own, so a batch either commits before a delete reads what the batch
// stored, or starts after the delete commits and finds its generation gone
// or its progress reset. The name is arbitrary; it only has to be the same
// for every Hub.
const PROJECTION_LOCK = 'heimdall-session-insight';

// Takes the projection's lock shared for `tx`'s transaction, unless a delete
// holds it or waits for it, and answers whether it did. A write that finds a
// delete under way is left to the next run.
const shareProjection = async (tx: SQL): Promise<boolean> => {
  const [row]: { held: boolean }[] = await tx`
    SELECT pg_try_advisory_xact_lock_shared(hashtext(${PROJECTION_LOCK})) AS held
  `;
  return row?.held === true;
};

// Takes the projection's lock alone for `tx`'s transaction, once every write
// under way has committed, as a delete does before it marks a generation.
export const holdProjection = async (tx: SQL): Promise<void> => {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${PROJECTION_LOCK}))`;
};

// Stores a batch's facts with the generation's progress in one transaction.
// Progress moves by compare-and-set: from `expected`, the `parsed_through` the
// batch was read from, or from no row at all when `expected` is null. When the
// progress changed under the run, as when a delete reset its Session, nothing
// of the batch is stored, and the next run reads again from the progress as it
// now stands.
const storeBatch = async (
  sql: SQL,
  {
    batch,
    expected,
    generation,
    heldSeen,
    parser,
    skipping,
  }: {
    batch: Batch;
    expected: string | null;
    generation: Generation;
    heldSeen: number;
    parser: HarnessParser;
    skipping: boolean;
  },
) => {
  await sql.begin(async (tx) => {
    if (!(await shareProjection(tx))) {
      return;
    }
    const progressed: unknown[] =
      expected === null
        ? await tx`
            INSERT INTO parse_progress (
              generation, parser_version, harness, session_id, parsed_through, held_seen,
              skipping_line, unreadable_lines
            )
            SELECT ${generation.id}::bigint, ${parser.version}, ${parser.harness},
                   ${batch.owner?.sessionId ?? null}, ${batch.parsedThrough}, ${heldSeen},
                   ${skipping}, ${batch.unreadableLines}
            WHERE EXISTS (
              SELECT 1 FROM transcript_generations
              WHERE id = ${generation.id}::bigint AND deleted_at IS NULL
            )
            ON CONFLICT DO NOTHING
            RETURNING generation
          `
        : await tx`
            UPDATE parse_progress SET
              session_id = COALESCE(${batch.owner?.sessionId ?? null}, session_id),
              parsed_through = ${batch.parsedThrough},
              held_seen = ${heldSeen},
              skipping_line = ${skipping},
              unreadable_lines = unreadable_lines + ${batch.unreadableLines}
            WHERE harness = ${parser.harness} AND parser_version = ${parser.version}
              AND generation = ${generation.id}::bigint AND parsed_through = ${Number(expected)}
            RETURNING generation
          `;
    if (progressed.length > 0) {
      await storeFacts(tx, { batch, generation, parser });
    }
  });
};

const hasFacts = (batch: Batch) =>
  batch.span !== null ||
  batch.agent !== null ||
  batch.requests.length > 0 ||
  batch.toolCalls.length > 0;

const at = (epochMs: number | undefined) => (epochMs === undefined ? null : new Date(epochMs));

// Writes a batch's facts for its owner. A Session's row exists once any of
// its files holds a fact, and its span and metadata come from its main
// conversation; a subagent's from its own transcript and `.meta.json`.
const storeFacts = async (
  tx: SQL,
  { batch, generation, parser }: { batch: Batch; generation: Generation; parser: HarnessParser },
) => {
  const { owner } = batch;
  if (owner === null || !hasFacts(batch)) {
    return;
  }
  const key = {
    harness: parser.harness,
    session: owner.sessionId,
    source: generation.source,
    system: generation.system,
    version: parser.version,
  };
  const main = owner.agentId === null && batch.transcript ? batch.span : null;
  await tx`
    INSERT INTO projected_sessions (
      parser_version, harness, system, source, session_id, path, started_at, ended_at,
      first_cwd, last_cwd, first_git_branch, last_git_branch, first_harness_version,
      last_harness_version
    )
    VALUES (
      ${key.version}, ${key.harness}, ${key.system}, ${key.source}, ${key.session},
      ${owner.agentId === null && batch.transcript ? generation.path : null},
      ${at(main?.first.at)}, ${at(main?.last.at)},
      ${main?.first.cwd ?? null}, ${main?.last.cwd ?? null},
      ${main?.first.gitBranch ?? null}, ${main?.last.gitBranch ?? null},
      ${main?.first.version ?? null}, ${main?.last.version ?? null}
    )
    ON CONFLICT (harness, parser_version, system, source, session_id) DO UPDATE SET
      path = COALESCE(excluded.path, projected_sessions.path),
      -- The batch's first moment wins when it is earlier, and its last when it
      -- is as late or later. Every SET reads the row as it was; a batch with no
      -- span never wins.
      first_cwd = CASE WHEN projected_sessions.started_at IS NULL OR excluded.started_at < projected_sessions.started_at
                  THEN excluded.first_cwd ELSE projected_sessions.first_cwd END,
      first_git_branch = CASE WHEN projected_sessions.started_at IS NULL OR excluded.started_at < projected_sessions.started_at
                         THEN excluded.first_git_branch ELSE projected_sessions.first_git_branch END,
      first_harness_version = CASE WHEN projected_sessions.started_at IS NULL OR excluded.started_at < projected_sessions.started_at
                              THEN excluded.first_harness_version
                              ELSE projected_sessions.first_harness_version END,
      last_cwd = CASE WHEN projected_sessions.ended_at IS NULL OR excluded.ended_at >= projected_sessions.ended_at
                 THEN excluded.last_cwd ELSE projected_sessions.last_cwd END,
      last_git_branch = CASE WHEN projected_sessions.ended_at IS NULL OR excluded.ended_at >= projected_sessions.ended_at
                        THEN excluded.last_git_branch ELSE projected_sessions.last_git_branch END,
      last_harness_version = CASE WHEN projected_sessions.ended_at IS NULL OR excluded.ended_at >= projected_sessions.ended_at
                             THEN excluded.last_harness_version
                             ELSE projected_sessions.last_harness_version END,
      started_at = LEAST(projected_sessions.started_at, excluded.started_at),
      ended_at = GREATEST(projected_sessions.ended_at, excluded.ended_at)
  `;
  if (owner.agentId !== null) {
    const span = batch.transcript ? batch.span : null;
    const { agent } = batch;
    await tx`
      INSERT INTO projected_subagents (
        parser_version, harness, system, source, session_id, agent_id, path, agent_type, depth,
        parent_agent_id, tool_use_id, workflow_run, workflow_phase, started_at, ended_at
      )
      VALUES (
        ${key.version}, ${key.harness}, ${key.system}, ${key.source}, ${key.session},
        ${owner.agentId}, ${batch.transcript ? generation.path : null},
        ${agent?.agentType ?? null}, ${agent?.depth ?? null}, ${agent?.parentAgentId ?? null},
        ${agent?.toolUseId ?? null}, ${agent?.workflowRun ?? null}, ${agent?.workflowPhase ?? null},
        ${at(span?.first.at)}, ${at(span?.last.at)}
      )
      ON CONFLICT (harness, parser_version, system, source, session_id, agent_id) DO UPDATE SET
        path = COALESCE(excluded.path, projected_subagents.path),
        agent_type = COALESCE(excluded.agent_type, projected_subagents.agent_type),
        depth = COALESCE(excluded.depth, projected_subagents.depth),
        parent_agent_id = COALESCE(excluded.parent_agent_id, projected_subagents.parent_agent_id),
        tool_use_id = COALESCE(excluded.tool_use_id, projected_subagents.tool_use_id),
        workflow_run = COALESCE(excluded.workflow_run, projected_subagents.workflow_run),
        workflow_phase = COALESCE(excluded.workflow_phase, projected_subagents.workflow_phase),
        started_at = LEAST(projected_subagents.started_at, excluded.started_at),
        ended_at = GREATEST(projected_subagents.ended_at, excluded.ended_at)
    `;
  }
  await storeRequests(tx, { batch, generation, key, owner });
  await storeToolCalls(tx, { batch, generation, key, owner });
};

type Key = { harness: string; session: string; source: string; system: string; version: number };
type Facts = { batch: Batch; generation: Generation; key: Key; owner: NonNullable<Batch['owner']> };

// A request counts once within a System's source, however many generations
// hold it. A later line of it replaces the one kept unless the kept line is
// final and the later one partial, so the final usage wins in any order.
const storeRequests = async (tx: SQL, { batch, generation, key, owner }: Facts) => {
  if (batch.requests.length === 0) {
    return;
  }
  await recordHolders(tx, {
    generation,
    ids: batch.requests.map((r) => r.requestId),
    key,
    table: 'projected_requests',
  });
  await tx`
    INSERT INTO projected_requests (
      parser_version, harness, system, source, session_id, agent_id, request_id, at, model,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
      cache_write_5m_tokens, cache_write_1h_tokens, stop_reason, skill, generation, byte_offset
    )
    SELECT ${key.version}, ${key.harness}, ${key.system}, ${key.source}, ${key.session},
           ${owner.agentId}, r."requestId", to_timestamp(r.at / 1000.0), r.model, r.input, r.output,
           r.reasoning, r."cacheRead", r."cacheWrite", r."cacheWrite5m", r."cacheWrite1h",
           r."stopReason", r.skill, ${generation.id}::bigint, r."offset"
    FROM jsonb_to_recordset(${storableJson(batch.requests)}::text::jsonb) AS r(
      "requestId" text, at double precision, model text, input bigint, output bigint,
      reasoning bigint, "cacheRead" bigint, "cacheWrite" bigint, "cacheWrite5m" bigint,
      "cacheWrite1h" bigint, "stopReason" text, skill text, "offset" bigint
    )
    ON CONFLICT (harness, parser_version, system, source, request_id) DO UPDATE SET
      session_id = excluded.session_id,
      agent_id = excluded.agent_id,
      at = excluded.at,
      model = excluded.model,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      cache_write_5m_tokens = excluded.cache_write_5m_tokens,
      cache_write_1h_tokens = excluded.cache_write_1h_tokens,
      stop_reason = excluded.stop_reason,
      skill = excluded.skill,
      generation = excluded.generation,
      byte_offset = excluded.byte_offset
    WHERE excluded.stop_reason IS NOT NULL OR projected_requests.stop_reason IS NULL
  `;
};

// Notes every generation that holds a fact another generation's row already
// keeps, the row's generation too, so a delete of either can derive the other
// again (`forgetDeletedGenerations`). Only facts held twice are noted, so the
// cost grows with what the archive duplicates, not with its size.
const recordHolders = async (
  tx: SQL,
  {
    generation,
    ids,
    key,
    table,
  }: {
    generation: Generation;
    ids: string[];
    key: Key;
    table: 'projected_requests' | 'projected_tool_calls';
  },
) => {
  const id = table === 'projected_requests' ? 'request_id' : 'call_id';
  await tx.unsafe(
    `INSERT INTO projected_holders (harness, parser_version, system, source, fact_id, generation)
     SELECT x.harness, x.parser_version, x.system, x.source, x.${id}, held.generation
     FROM ${table} x
     CROSS JOIN LATERAL (VALUES (x.generation), ($5::bigint)) AS held (generation)
     WHERE x.harness = $1 AND x.parser_version = $2 AND x.system = $3 AND x.source = $4
       AND x.${id} IN (SELECT jsonb_array_elements_text($6::text::jsonb))
       AND x.generation <> $5::bigint
     ON CONFLICT DO NOTHING`,
    [key.harness, key.version, key.system, key.source, generation.id, storableJson(ids)],
  );
};

// A tool call counts once within a System's source; the first line read keeps it.
const storeToolCalls = async (tx: SQL, { batch, generation, key, owner }: Facts) => {
  if (batch.toolCalls.length === 0) {
    return;
  }
  await recordHolders(tx, {
    generation,
    ids: batch.toolCalls.map((t) => t.callId),
    key,
    table: 'projected_tool_calls',
  });
  await tx`
    INSERT INTO projected_tool_calls (
      parser_version, harness, system, source, session_id, agent_id, call_id, request_id, at,
      kind, name, mcp_server, skill, generation, byte_offset
    )
    SELECT ${key.version}, ${key.harness}, ${key.system}, ${key.source}, ${key.session},
           ${owner.agentId}, t."callId", t."requestId", to_timestamp(t.at / 1000.0), t.kind,
           t.name, t."mcpServer", t.skill, ${generation.id}::bigint, t."offset"
    FROM jsonb_to_recordset(${storableJson(batch.toolCalls)}::text::jsonb) AS t(
      "callId" text, "requestId" text, at double precision, kind text, name text,
      "mcpServer" text, skill text, "offset" bigint
    )
    ON CONFLICT (harness, parser_version, system, source, call_id) DO NOTHING
  `;
};

// Switches the views to `parser`'s version once it has caught up, in one
// statement, and answers whether it switched. A first version has caught up
// when no generation is pending for it. A rebuild has caught up when it has
// read every generation at least as far as the current version has, unless it
// failed there, so uploads that land during the rebuild, which the current
// version has not read either, never hold the switch back. The current
// version only moves forward, so two Hubs cannot switch back and forth.
const switchVersion = async (sql: SQL, parser: HarnessParser): Promise<boolean> => {
  const switched: unknown[] = await sql`
    WITH cur AS (SELECT version FROM current_parsers WHERE harness = ${parser.harness})
    INSERT INTO current_parsers (harness, version)
    SELECT ${parser.harness}, ${parser.version}
    WHERE NOT EXISTS (
      SELECT 1
      FROM transcript_generations g
      JOIN transcript_source_harnesses h ON h.system = g.system AND h.source = g.source
      LEFT JOIN parse_progress n
        ON n.harness = h.harness AND n.parser_version = ${parser.version} AND n.generation = g.id
      LEFT JOIN parse_progress o
        ON o.harness = h.harness AND o.parser_version = (SELECT version FROM cur)
       AND o.generation = g.id
      WHERE h.harness = ${parser.harness} AND g.deleted_at IS NULL
        AND n.failed_at IS NULL AND (n.generation IS NULL OR n.held_seen < g.held)
        AND (NOT EXISTS (SELECT 1 FROM cur)
             OR (o.failed_at IS NULL AND o.generation IS NOT NULL
                 AND (n.generation IS NULL OR n.held_seen < o.held_seen)))
    )
    ON CONFLICT (harness) DO UPDATE SET version = excluded.version
    WHERE current_parsers.version < excluded.version
    RETURNING version
  `;
  return switched.length > 0;
};

// Deletes up to `rows` rows from each table of `harness`'s versions earlier
// than its current one, such as the version a switch replaced. Progress goes
// last, once no earlier fact is left, so it says whether any remain and a run
// with none scans no facts. A version later than the current one is another
// Hub's rebuild, and stays.
const dropEarlierVersions = async (
  sql: SQL,
  { harness, rows }: { harness: string; rows: number },
) => {
  const current = await currentVersion(sql, harness);
  if (current === undefined) {
    return;
  }
  const stale: unknown[] = await sql`
    SELECT 1 FROM parse_progress WHERE harness = ${harness} AND parser_version < ${current} LIMIT 1
  `;
  if (stale.length === 0) {
    return;
  }
  for (const table of PROJECTED_TABLES) {
    // oxlint-disable-next-line no-await-in-loop -- one table at a time, progress last.
    const deleted = await sql.unsafe(
      `DELETE FROM ${table} WHERE ctid IN (
         SELECT ctid FROM ${table} WHERE harness = $1 AND parser_version < $2 LIMIT $3
       )`,
      [harness, current, rows],
    );
    if (deleted.count >= rows) {
      return;
    }
  }
};

const PROJECTED_TABLES = [
  'projected_requests',
  'projected_tool_calls',
  'projected_subagents',
  'projected_sessions',
  'projected_holders',
  'parse_progress',
] as const;

// Removes what the projection derived from generations deleted on purpose
// (ADR-0013, ADR-0014), so the projection is what the surviving archive
// yields:
//
// - Every Session the deleted generations touched loses its facts, under
//   every parser version, and every other generation of it is reset to be
//   parsed from its start. The Session is hidden from the views until its
//   current version has parsed it again, so it reappears whole.
// - A fact the deleted Sessions kept that another Session's generation also
//   holds, as `projected_holders` notes, sends that generation to be parsed
//   again. Its Session keeps its facts, which parsing again only restores.
//
// A Session touched while a rebuild runs stays hidden until the rebuild's
// version is current and has parsed it again. Answers how many Sessions it
// touched.
export const forgetDeletedGenerations = async (sql: SQL): Promise<number> => {
  const [row]: { touched: number }[] = await sql`
    WITH deleted AS (
      SELECT p.harness, p.generation, g.system, g.source, p.session_id
      FROM parse_progress p
      JOIN transcript_generations g ON g.id = p.generation
      WHERE g.deleted_at IS NOT NULL
    ),
    touched AS (
      SELECT DISTINCT harness, system, source, session_id FROM deleted WHERE session_id IS NOT NULL
    ),
    hidden AS (
      INSERT INTO rederiving_sessions (harness, system, source, session_id)
      SELECT * FROM touched
      ON CONFLICT DO NOTHING
    ),
    kept AS (
      SELECT x.harness, x.parser_version, x.system, x.source, x.request_id AS fact_id
      FROM projected_requests x JOIN touched t USING (harness, system, source, session_id)
      UNION
      SELECT x.harness, x.parser_version, x.system, x.source, x.call_id
      FROM projected_tool_calls x JOIN touched t USING (harness, system, source, session_id)
    ),
    holders AS (
      SELECT DISTINCT h.harness, h.parser_version, h.generation
      FROM projected_holders h JOIN kept k USING (harness, parser_version, system, source, fact_id)
    ),
    forgotten AS (
      DELETE FROM parse_progress WHERE generation IN (SELECT generation FROM deleted)
    ),
    reset AS (
      UPDATE parse_progress p SET
        parsed_through = 0, held_seen = 0, skipping_line = false, unreadable_lines = 0,
        failed_at = NULL, failure = NULL
      FROM transcript_generations g
      WHERE g.id = p.generation AND g.deleted_at IS NULL
        AND ((p.harness, g.system, g.source, p.session_id) IN (SELECT * FROM touched)
             OR (p.harness, p.parser_version, p.generation) IN (SELECT * FROM holders))
    ),
    unheld AS (
      DELETE FROM projected_holders WHERE generation IN (SELECT generation FROM deleted)
    ),
    requests AS (
      DELETE FROM projected_requests x USING touched t
      WHERE (x.harness, x.system, x.source, x.session_id) = (t.harness, t.system, t.source, t.session_id)
    ),
    tool_calls AS (
      DELETE FROM projected_tool_calls x USING touched t
      WHERE (x.harness, x.system, x.source, x.session_id) = (t.harness, t.system, t.source, t.session_id)
    ),
    subagents AS (
      DELETE FROM projected_subagents x USING touched t
      WHERE (x.harness, x.system, x.source, x.session_id) = (t.harness, t.system, t.source, t.session_id)
    ),
    sessions AS (
      DELETE FROM projected_sessions x USING touched t
      WHERE (x.harness, x.system, x.source, x.session_id) = (t.harness, t.system, t.source, t.session_id)
    )
    SELECT count(*)::int AS touched FROM touched
  `;
  return row?.touched ?? 0;
};

// Shows again each Session of `harness` a delete hid, once its current
// version has parsed every generation of it that the delete reset, or failed
// there.
// Under the projection's lock, so it sees a delete whole or not at all.
const showRederived = (sql: SQL, harness: string) =>
  sql.begin(async (tx) => {
    if (!(await shareProjection(tx))) {
      return;
    }
    await tx`
  DELETE FROM rederiving_sessions r
  USING current_parsers c
  WHERE r.harness = ${harness} AND c.harness = r.harness
    AND NOT EXISTS (
      SELECT 1 FROM parse_progress p
      JOIN transcript_generations g ON g.id = p.generation
      WHERE p.harness = r.harness AND p.parser_version = c.version
        AND p.session_id = r.session_id AND g.system = r.system AND g.source = r.source
        AND g.deleted_at IS NULL AND p.failed_at IS NULL AND p.held_seen < g.held
    )
    `;
  });
