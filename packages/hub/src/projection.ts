import type { SQL } from 'bun';

import { claudeCodeParser } from './claude-code-parser.ts';
import type { Batch, HarnessParser } from './session-facts.ts';
import { storableJson } from './store.ts';
import { readHeldContent } from './transcript-reader.ts';

// The parsers the Hub runs, one per Harness it derives Session insight for.
export const PARSERS: readonly HarnessParser[] = [claudeCodeParser];

// How much transcript content one run parses at most, across generations. A
// run reads whole chunks, so it can pass the budget by up to a chunk, and by
// more for a line longer than the budget, which it reads whole.
export const PARSE_BUDGET_BYTES = 64 * 2 ** 20;

// How many generations one run considers at most.
const GENERATIONS_PER_RUN = 1000;

// A full rebuild's cleanup can outlast the usual statement timeout.
const CLEANUP_TIMEOUT = '10min';

// What a run left: generations not yet parsed through what the Hub holds, and
// each Harness whose views it switched to a newly complete parser version.
export type Projected = {
  pending: number;
  switched: { harness: string; version: number }[];
};

type Pending = {
  held: string;
  id: string;
  parsed_through: string | null;
  path: string;
  source: string;
  system: string;
};

// Parses what the archive holds and no parser version has read yet, then
// switches each Harness whose next version is complete (ADR-0014). Each
// generation's batch commits with its progress, so a run that stops, or a Hub
// that restarts, loses nothing and resumes from the progress. A parser whose
// version has no complete set yet writes beside the current one, which the
// `insight` views keep showing until every generation is parsed; then the
// views switch in one statement and the earlier version's rows are deleted.
export const projectTranscripts = async (
  sql: SQL,
  {
    budgetBytes = PARSE_BUDGET_BYTES,
    parsers = PARSERS,
  }: { budgetBytes?: number; parsers?: readonly HarnessParser[] } = {},
): Promise<Projected> => {
  await forgetDeletedGenerations(sql);
  let budget = budgetBytes;
  let pending = 0;
  const switched: Projected['switched'] = [];
  const errors: unknown[] = [];
  for (const parser of parsers) {
    // oxlint-disable-next-line no-await-in-loop -- one Harness at a time.
    const work = await pendingGenerations(sql, parser);
    for (const generation of work) {
      if (budget <= 0) {
        break;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- the budget is shared, so in turn.
        budget -= await parseGeneration(sql, parser, generation, budget);
      } catch (error) {
        errors.push(error);
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- one Harness at a time.
    const left = await pendingCount(sql, parser);
    pending += left;
    // oxlint-disable-next-line no-await-in-loop -- one Harness at a time.
    if (left === 0 && (await switchVersion(sql, parser))) {
      switched.push({ harness: parser.harness, version: parser.version });
    }
    // oxlint-disable-next-line no-await-in-loop -- one Harness at a time.
    await dropStaleVersions(sql, parser);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Could not parse ${String(errors.length)} generations.`);
  }
  return { pending, switched };
};

// Generations of `parser`'s Harness that its version has not read through what
// the Hub holds, oldest upload first. A source runs the Harness its System's
// Reports named for it.
const pendingGenerations = (sql: SQL, parser: HarnessParser): Promise<Pending[]> => sql`
  SELECT g.id, g.system, g.source, g.path, g.held, p.parsed_through
  FROM transcript_generations g
  JOIN transcript_source_harnesses h ON h.system = g.system AND h.source = g.source
  LEFT JOIN parse_progress p ON p.generation = g.id AND p.parser_version = ${parser.version}
  WHERE h.harness = ${parser.harness} AND g.deleted_at IS NULL
    AND (p.generation IS NULL OR p.held_seen < g.held)
  ORDER BY g.last_upload_at, g.id
  LIMIT ${GENERATIONS_PER_RUN}
`;

const pendingCount = async (sql: SQL, parser: HarnessParser) => {
  const [row]: { n: number }[] = await sql`
    SELECT count(*)::int AS n
    FROM transcript_generations g
    JOIN transcript_source_harnesses h ON h.system = g.system AND h.source = g.source
    LEFT JOIN parse_progress p ON p.generation = g.id AND p.parser_version = ${parser.version}
    WHERE h.harness = ${parser.harness} AND g.deleted_at IS NULL
      AND (p.generation IS NULL OR p.held_seen < g.held)
  `;
  return row?.n ?? 0;
};

// Parses one batch of a generation from where its progress stopped, within
// `budget` bytes, and answers the bytes it read. A file the parser does not
// read is marked parsed through what the Hub holds, unread.
const parseGeneration = async (
  sql: SQL,
  parser: HarnessParser,
  row: Pending,
  budget: number,
): Promise<number> => {
  const generation = { ...row, held: Number(row.held), id: Number(row.id) };
  const from = row.parsed_through === null ? 0 : Number(row.parsed_through);
  if (!parser.reads(row.path)) {
    await storeBatch(sql, {
      batch: { ...EMPTY, parsedThrough: generation.held },
      expected: row.parsed_through,
      generation,
      heldSeen: generation.held,
      parser,
    });
    return 0;
  }
  // A line longer than the budget is read whole, by doubling what is read.
  for (let limit = budget; ; limit *= 2) {
    // oxlint-disable-next-line no-await-in-loop -- reads more only when a line did not fit.
    const { complete, content } = await readHeldContent(sql, {
      from,
      generation: generation.id,
      held: generation.held,
      limitBytes: limit,
    });
    const batch = parser.parse({ complete, content, offset: from, path: row.path });
    if (batch.parsedThrough > from || complete) {
      // oxlint-disable-next-line no-await-in-loop -- the loop ends here.
      await storeBatch(sql, {
        batch,
        expected: row.parsed_through,
        generation,
        // Content read only in part stays pending for the next run.
        heldSeen: complete ? generation.held : from + content.byteLength,
        parser,
      });
      return content.byteLength;
    }
    // A read as large as the whole generation that still stops short of
    // `held` means its chunks do.
    if (limit > generation.held) {
      throw new Error(
        `Generation ${row.id} holds no chunk past byte ${String(from + content.byteLength)}.`,
      );
    }
  }
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

// Stores a batch's facts with the generation's progress in one transaction.
// The progress must still be what the batch was read from, `expected`, or
// null for a generation never parsed. Otherwise it changed under the run, as
// when a delete reset its Session, and the batch is dropped: the next run
// reads again from the progress as it now stands.
const storeBatch = async (
  sql: SQL,
  {
    batch,
    expected,
    generation,
    heldSeen,
    parser,
  }: {
    batch: Batch;
    expected: string | null;
    generation: Generation;
    heldSeen: number;
    parser: HarnessParser;
  },
) => {
  await sql.begin(async (tx) => {
    const progressed: unknown[] = await tx`
      INSERT INTO parse_progress (
        generation, parser_version, harness, session_id, parsed_through, held_seen, unreadable_lines
      )
      VALUES (${generation.id}::bigint, ${parser.version}, ${parser.harness},
              ${batch.owner?.sessionId ?? null}, ${batch.parsedThrough}, ${heldSeen},
              ${batch.unreadableLines})
      ON CONFLICT (generation, parser_version) DO UPDATE SET
        session_id = COALESCE(excluded.session_id, parse_progress.session_id),
        parsed_through = excluded.parsed_through,
        held_seen = excluded.held_seen,
        unreadable_lines = parse_progress.unreadable_lines + excluded.unreadable_lines
      WHERE parse_progress.parsed_through = ${expected === null ? -1 : Number(expected)}
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
    ON CONFLICT (parser_version, system, source, session_id) DO UPDATE SET
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
      ON CONFLICT (parser_version, system, source, session_id, agent_id) DO UPDATE SET
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
    ON CONFLICT (parser_version, system, source, request_id) DO UPDATE SET
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

// A tool call counts once within a System's source; the first line read keeps it.
const storeToolCalls = async (tx: SQL, { batch, generation, key, owner }: Facts) => {
  if (batch.toolCalls.length === 0) {
    return;
  }
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
    ON CONFLICT (parser_version, system, source, call_id) DO NOTHING
  `;
};

// Switches the views to `parser`'s version once every generation of its
// Harness is parsed through what the Hub holds, judged again under a lock so
// two Hubs on one database cannot both switch. Answers whether it switched.
const switchVersion = (sql: SQL, parser: HarnessParser): Promise<boolean> =>
  sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`heimdall-insight-${parser.harness}`}))`;
    const [row]: { version: number }[] = await tx`
      SELECT version FROM current_parsers WHERE harness = ${parser.harness}
    `;
    if (row?.version === parser.version || (await pendingCount(tx, parser)) > 0) {
      return false;
    }
    await tx`
      INSERT INTO current_parsers (harness, version) VALUES (${parser.harness}, ${parser.version})
      ON CONFLICT (harness) DO UPDATE SET version = excluded.version
    `;
    return true;
  });

// Deletes the rows of `parser`'s Harness written by a version that is neither
// current nor `parser`'s own, such as the version a switch replaced. Progress
// rows say whether there are any, so a run with none scans no facts.
const dropStaleVersions = (sql: SQL, parser: HarnessParser) =>
  sql.begin(async (tx) => {
    const [row]: { version: number }[] = await tx`
      SELECT version FROM current_parsers WHERE harness = ${parser.harness}
    `;
    const current = row?.version ?? parser.version;
    const stale: unknown[] = await tx`
      SELECT 1 FROM parse_progress
      WHERE harness = ${parser.harness}
        AND parser_version <> ${parser.version} AND parser_version <> ${current}
      LIMIT 1
    `;
    if (stale.length === 0) {
      return;
    }
    await tx.unsafe(`SET LOCAL statement_timeout = '${CLEANUP_TIMEOUT}'`);
    for (const table of PROJECTED_TABLES) {
      // oxlint-disable-next-line no-await-in-loop -- one table at a time, in one transaction.
      await tx.unsafe(
        `DELETE FROM ${table} WHERE harness = $1 AND parser_version <> $2 AND parser_version <> $3`,
        [parser.harness, parser.version, current],
      );
    }
  });

const PROJECTED_TABLES = [
  'projected_requests',
  'projected_tool_calls',
  'projected_subagents',
  'projected_sessions',
  'parse_progress',
] as const;

// Removes what the projection derived from generations deleted on purpose,
// and forgets the progress of every other generation of the Sessions they
// touched, so the next run derives those Sessions again from what still holds
// them (ADR-0013, ADR-0014). Every parser version's rows go, the current
// one's too, so a Session touched while a rebuild runs shows again once the
// rebuild completes. Answers how many Sessions it touched.
export const forgetDeletedGenerations = async (sql: SQL): Promise<number> => {
  const [row]: { touched: number }[] = await sql`
    WITH deleted AS (
      SELECT p.generation, g.system, g.source, p.session_id
      FROM parse_progress p
      JOIN transcript_generations g ON g.id = p.generation
      WHERE g.deleted_at IS NOT NULL
    ),
    touched AS (
      SELECT DISTINCT system, source, session_id FROM deleted WHERE session_id IS NOT NULL
    ),
    progress AS (
      DELETE FROM parse_progress p
      USING transcript_generations g
      WHERE g.id = p.generation
        AND (p.generation IN (SELECT generation FROM deleted)
             OR (g.system, g.source, p.session_id) IN (SELECT * FROM touched))
    ),
    requests AS (
      DELETE FROM projected_requests x USING touched t
      WHERE (x.system, x.source, x.session_id) = (t.system, t.source, t.session_id)
    ),
    tool_calls AS (
      DELETE FROM projected_tool_calls x USING touched t
      WHERE (x.system, x.source, x.session_id) = (t.system, t.source, t.session_id)
    ),
    subagents AS (
      DELETE FROM projected_subagents x USING touched t
      WHERE (x.system, x.source, x.session_id) = (t.system, t.source, t.session_id)
    ),
    sessions AS (
      DELETE FROM projected_sessions x USING touched t
      WHERE (x.system, x.source, x.session_id) = (t.system, t.source, t.session_id)
    )
    SELECT count(*)::int AS touched FROM touched
  `;
  return row?.touched ?? 0;
};
