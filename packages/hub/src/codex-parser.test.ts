import { beforeAll, describe, expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { codexParser, requestIdOf } from './codex-parser.ts';
import { syncPrices } from './price-table.ts';
import { projectTranscripts } from './projection.ts';
import { refreshSessionInsight } from './stored-insight.ts';
import { assistant, jsonl as claudeJsonl, mainPath } from './testing/claude-code.ts';
import {
  CHILD,
  CACHE_WRITE,
  FINAL_USAGE,
  FORK,
  completed,
  jsonl,
  MAIN,
  LEGACY_FORK,
  INTERRUPTED,
  NESTED,
  NESTED_FILE,
  meta,
  rolloutPath,
  SESSION,
  skillMessage,
  TOOLS,
  turn,
  tokenCount,
  turnStarted,
  usage,
  withUsage,
} from './testing/codex.ts';
import { NOW, openGeneration, push, report, sendChunk, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { startTestServer } from './testing/postgres.ts';
import { deleteTranscripts } from './transcripts.ts';

const parse = (content: string) =>
  codexParser.parse({
    complete: true,
    content: new TextEncoder().encode(content),
    factLimit: 100_000,
    offset: 0,
    path: rolloutPath(),
  });

describe('Codex rollouts', () => {
  test('requestIdOf identifies explicit response ids and cannot associate ordinary items or token counts', () => {
    expect(requestIdOf(usage('resp-hook', 't'))).toBe('resp-hook');
    expect(requestIdOf({ payload: { response_id: 'resp-explicit' }, type: 'event_msg' })).toBe(
      'resp-explicit',
    );
    expect(requestIdOf(tokenCount())).toBeNull();
    expect(requestIdOf(completed({ id: 'item-1', type: 'FileChange' }))).toBeNull();
    expect(requestIdOf(skillMessage())).toBeNull();
    expect(requestIdOf({ payload: { response_id: 'prose id' } })).toBeNull();
    expect(requestIdOf({ payload: { response_id: 'r'.repeat(256) } })).toBeNull();
    expect(requestIdOf(null)).toBeNull();
  });

  test('requestIdOf never treats a thread or item id as a response id', () => {
    expect(requestIdOf(meta())).toBeNull();
    expect(requestIdOf({ payload: { id: 'item-id' }, type: 'response_item' })).toBeNull();
    expect(requestIdOf({ payload: { id: 'generic-id' } })).toBeNull();
    expect(requestIdOf({ id: 'outer-id' })).toBeNull();
    expect(requestIdOf({ payload: {} })).toBeNull();
  });
  test.each(['0.154.0', '0.162.1'])('session_meta identifies a Session on Codex %s', (version) => {
    const batch = parse(jsonl([meta({ version })]));

    expect(batch.owner).toEqual({ agentId: null, sessionId: SESSION });
    expect(batch.span?.first).toEqual({
      at: Date.UTC(2026, 9, 6, 12),
      cwd: '/work/project',
      gitBranch: null,
      version,
    });
  });

  test('per-response usage reconciles with final cumulative usage despite repeated token_count events', () => {
    const batch = parse(MAIN);

    expect(batch.requests.map((r) => [r.requestId, r.model])).toEqual([
      ['resp-1', 'gpt-5.4'],
      ['resp-2', 'gpt-5.4-mini'],
    ]);
    expect(batch.requests.reduce((sum, r) => sum + r.input + r.cacheRead, 0)).toBe(
      FINAL_USAGE.input_tokens,
    );
    expect(batch.requests.reduce((sum, r) => sum + r.output, 0)).toBe(FINAL_USAGE.output_tokens);
    expect(batch.requests.reduce((sum, r) => sum + r.cacheRead, 0)).toBe(
      FINAL_USAGE.cached_input_tokens,
    );
    expect(batch.requests.reduce((sum, r) => sum + (r.reasoning ?? 0), 0)).toBe(
      FINAL_USAGE.reasoning_output_tokens,
    );
    expect(batch.requests.map((r) => r.contextWindow)).toEqual([258_400, 258_400]);
  });

  test('a fork links its subagent and drops replayed ordinals even without parent matches', () => {
    const batch = parse(FORK);

    expect(batch.owner).toEqual({ agentId: CHILD, sessionId: SESSION });
    expect(batch.requests.map((r) => r.requestId)).toEqual(['child-response']);
    expect(batch.unreadableLines).toBe(0);
  });

  test('replay follows explicit ordinals rather than physical line numbers or timestamps', () => {
    const own = meta({ id: CHILD });
    const batch = parse(
      jsonl([
        {
          ...own,
          payload: {
            ...own.payload,
            parent_thread_id: SESSION,
            subagent_history_start_ordinal: 100,
          },
        },
        { ...turn('replay', 'gpt-5.4', 30), ordinal: 99 },
        { ...usage('replayed', 'replay', 40), ordinal: 99 },
        { ...turn('own', 'gpt-5.4-mini', 0), ordinal: 100 },
        { ...turnStarted('own'), ordinal: 101 },
        { ...usage('own-response', 'own', 0, CHILD), ordinal: 102 },
      ]),
    );
    expect(batch.requests.map((r) => r.requestId)).toEqual(['own-response']);
    expect(batch.span?.last.at).toBe(Date.UTC(2026, 9, 6, 12, 0, 1));
  });

  test('a program-started fork without parent_thread_id stays a Session of its own', () => {
    const own = meta({ id: CHILD });
    const batch = parse(
      jsonl([
        {
          ...own,
          payload: {
            ...own.payload,
            forked_from_id: SESSION,
            source: 'exec',
            subagent_history_start_ordinal: 1,
          },
        },
        turn('own'),
        usage('own-response', 'own', 2, CHILD),
      ]),
    );
    expect(batch.owner).toEqual({ agentId: null, sessionId: CHILD });
    expect(batch.requests).toHaveLength(1);
  });

  test('completed items count tools inside exec and skill reads and messages are explicitly inferred', () => {
    const batch = parse(TOOLS);

    expect(
      batch.toolCalls.filter((t) => t.kind === 'tool').map((t) => [t.name, t.mcpServer]),
    ).toEqual([
      ['CommandExecution', null],
      ['Skill', null],
      ['search', 'docs'],
      ['FileChange', null],
      ['spawn_agent', null],
      ['Skill', null],
    ]);
    expect(
      batch.toolCalls.filter((t) => t.skill !== null).map((t) => [t.skill, t.skillInferred]),
    ).toEqual([
      ['tdd', true],
      ['namespace:review', true],
    ]);
    expect(batch.unreadableLines).toBe(0);
  });

  test('every inferred skill has its own tool row and never annotates the command that read it', () => {
    const batch = parse(
      jsonl([
        meta(),
        completed({
          command: ['cat', '/mock/skills/tdd/SKILL.md', '/mock/skills/review/SKILL.md'],
          id: 'read-skills',
          type: 'CommandExecution',
        }),
      ]),
    );
    expect(batch.toolCalls.map((t) => [t.kind, t.name, t.skill, t.skillInferred])).toEqual([
      ['tool', 'CommandExecution', null, false],
      ['tool', 'Skill', 'tdd', true],
      ['tool', 'Skill', 'review', true],
    ]);
  });

  test('a resumed batch retains child identity, replay boundary, turn model, and context window', () => {
    const content = new TextEncoder().encode(FORK);
    const split = FORK.indexOf('"type":"token_usage_record"', FORK.indexOf('"child-turn"'));
    const offset = FORK.lastIndexOf('\n', split) + 1;
    const first = codexParser.parse({
      complete: false,
      content: content.subarray(0, offset),
      factLimit: 100,
      offset: 0,
      path: rolloutPath(),
    });
    const last = codexParser.parse({
      complete: true,
      content: content.subarray(offset),
      factLimit: 100,
      offset,
      path: rolloutPath(),
      state: first.state,
    });

    expect(last.owner).toEqual({ agentId: CHILD, sessionId: SESSION });
    expect(last.requests.map((r) => [r.requestId, r.model, r.contextWindow])).toEqual([
      ['child-response', 'gpt-5.4-mini', 258_400],
    ]);
  });

  test('usage uses its turn model and window even after a later turn changes both', () => {
    const batch = parse(
      jsonl([
        meta(),
        turn('old', 'gpt-5.4'),
        turnStarted('old', 258_400),
        turn('new', 'gpt-5.4-mini'),
        turnStarted('new', 128_000),
        usage('late-old', 'old'),
        usage('new-response', 'new'),
      ]),
    );
    expect(batch.requests.map((r) => [r.model, r.contextWindow])).toEqual([
      ['gpt-5.4', 258_400],
      ['gpt-5.4-mini', 128_000],
    ]);
  });

  test.each([
    meta({ id: 'prompt prose' }),
    { ...meta(), timestamp: 'invalid' },
    { ...meta(), payload: null },
  ])(
    'a copied header cannot give identity to a file whose own header is invalid (%j)',
    (header) => {
      const batch = parse(jsonl([header, meta(), turn('t'), usage('resp', 't')]));
      expect(batch.owner).toBeNull();
      expect(batch.requests).toEqual([]);
      expect(batch.unreadableLines).toBe(1);
    },
  );

  test.each(['truncated JSON', 'array'])(
    'an unreadable first record cannot adopt a copied parent header (%s)',
    (kind) => {
      const newline = FORK.indexOf('\n');
      const first = kind === 'array' ? '[1]' : FORK.slice(0, newline - 1);
      const batch = parse(`${first}${FORK.slice(newline)}`);
      expect(batch.owner).toBeNull();
      expect(batch.span).toBeNull();
      expect(batch.requests).toEqual([]);
      expect(batch.toolCalls).toEqual([]);
      expect(batch.unreadableLines).toBe(1);
    },
  );

  test.each([
    ['empty object', '{}'],
    ['response item', JSON.stringify(skillMessage())],
  ])('a non-header first record cannot adopt copied parent identity (%s)', (_kind, first) => {
    const batch = parse(first + FORK.slice(FORK.indexOf('\n')));
    expect(batch.owner).toBeNull();
    expect(batch.agent).toBeNull();
    expect(batch.span).toBeNull();
    expect(batch.requests).toEqual([]);
    expect(batch.toolCalls).toEqual([]);
    expect(batch.unreadableLines).toBe(1);
  });

  test('a legacy fork without a replay cutoff is unreadable and yields no records', () => {
    const batch = parse(LEGACY_FORK);
    expect(batch.owner).toBeNull();
    expect(batch.span).toBeNull();
    expect(batch.requests).toEqual([]);
    expect(batch.toolCalls).toEqual([]);
    expect(batch.unreadableLines).toBe(1);
  });

  test('nonzero cache writes are separated from input without adding context tokens', () => {
    const [request] = parse(CACHE_WRITE).requests;
    expect(request?.input).toBe(40);
    expect(request?.cacheRead).toBe(40);
    expect(request?.cacheWrite).toBe(20);
    expect(
      request === undefined ? null : request.input + request.cacheRead + request.cacheWrite,
    ).toBe(100);
  });

  test('cache reads plus writes exceeding input drop the request and count it unreadable', () => {
    const batch = parse(
      jsonl([
        meta(),
        turn('t'),
        withUsage(usage('bad-cache', 't'), {
          cache_write_input_tokens: 20,
          input_tokens: 50,
        }),
      ]),
    );
    expect(batch.requests).toEqual([]);
    expect(batch.unreadableLines).toBe(1);
  });

  test('reasoning exceeding output drops the request and counts it unreadable', () => {
    const batch = parse(
      jsonl([
        meta(),
        turn('t'),
        withUsage(usage('bad-reasoning', 't'), {
          reasoning_output_tokens: 21,
        }),
      ]),
    );
    expect(batch.requests).toEqual([]);
    expect(batch.unreadableLines).toBe(1);
  });

  test('token_count supplies a context window when turn_started did not record one', () => {
    const batch = parse(jsonl([meta(), turn('t'), tokenCount(), usage('fallback', 't')]));
    expect(batch.requests[0]?.contextWindow).toBe(258_400);
    expect(batch.requests).toHaveLength(1);
  });

  test('listing available skill files does not infer a skill invocation', () => {
    const batch = parse(
      jsonl([
        meta(),
        completed({
          command: ['ls', '/mock/skills/tdd/SKILL.md'],
          id: 'list-skills',
          type: 'CommandExecution',
        }),
      ]),
    );
    expect(batch.toolCalls.map((t) => [t.name, t.skill, t.skillInferred])).toEqual([
      ['CommandExecution', null, false],
    ]);
  });

  test.each(['assistant', 'developer', 'system'])(
    'a %s skill message does not infer a user invocation',
    (role) => {
      const batch = parse(jsonl([meta(), skillMessage(role)]));
      expect(batch.toolCalls).toEqual([]);
      expect(batch.unreadableLines).toBe(0);
    },
  );

  test.each([undefined, 'server prose'])(
    'an MCP item without a shaped server is unreadable (%s)',
    (server) => {
      const batch = parse(
        jsonl([
          meta(),
          completed({
            id: 'bad-mcp',
            server,
            tool: 'search',
            type: 'McpToolCall',
          }),
        ]),
      );
      expect(batch.toolCalls).toEqual([]);
      expect(batch.unreadableLines).toBe(1);
    },
  );

  test('turn_started without a window preserves the one learned from token_count', () => {
    const started = turnStarted('t');
    const batch = parse(
      jsonl([
        meta(),
        turn('t'),
        tokenCount(),
        { ...started, payload: { turn_id: 't', type: 'turn_started' } },
        usage('known-window', 't'),
      ]),
    );
    expect(batch.requests[0]?.contextWindow).toBe(258_400);
  });

  test('usage before turn context and for an unknown turn keeps unpriced requests and their totals', () => {
    const batch = parse(
      jsonl([
        meta(),
        usage('before-context', 'not-seen'),
        turn('known'),
        usage('unknown-turn', 'missing'),
      ]),
    );
    expect(batch.requests.map((r) => [r.requestId, r.model, r.stopReason])).toEqual([
      ['before-context', 'unknown', 'completed'],
      ['unknown-turn', 'unknown', 'completed'],
    ]);
    expect(
      batch.requests.reduce((sum, r) => sum + r.input + r.cacheRead + r.cacheWrite + r.output, 0),
    ).toBe(240);
    expect(batch.unreadableLines).toBe(0);
  });

  test('cached input exceeding input remains unreadable even when the turn model is unknown', () => {
    const batch = parse(
      jsonl([meta(), withUsage(usage('invalid', 'missing'), { input_tokens: 30 })]),
    );
    expect(batch.requests).toEqual([]);
    expect(batch.unreadableLines).toBe(1);
  });

  test('usage records are completed requests and interrupted responses without usage are absent', () => {
    expect(parse(MAIN).requests.map((r) => r.stopReason)).toEqual(['completed', 'completed']);
    const interrupted = parse(INTERRUPTED);
    expect(interrupted.requests).toEqual([]);
    expect(interrupted.unreadableLines).toBe(0);
  });
});

const upload = async (h: Hub, content: string, path: string, source = 'coding') => {
  const opened = await openGeneration(h.hub, { path, source }, { token: 'laptop-token' });
  expect(opened.status).toBe(201);
  const result: unknown = await opened.json();
  if (
    typeof result !== 'object' ||
    result === null ||
    !('generation' in result) ||
    typeof result.generation !== 'number'
  ) {
    throw new Error('No generation returned.');
  }
  const response = await sendChunk(h.hub, result.generation, {
    content,
    offset: 0,
    token: 'laptop-token',
  });
  expect(response.status).toBe(200);
  return result.generation;
};

const nameSources = async (h: Hub) => {
  const response = await push(
    h.hub,
    {
      ...report('laptop-1', [NOW]),
      transcripts: {
        sources: [
          { harness: 'codex', name: 'coding', status: 'capturing' },
          { harness: 'claude-code', name: 'claude-code', status: 'capturing' },
        ],
        spool: { bytes: 0, oldestAt: null },
      },
    },
    { token: 'laptop-token' },
  );
  expect(response.status).toBe(200);
};

// Inject a linker rollback after real batches committed their byte progress.
const linkFailsOnce = (sql: SQL): SQL => {
  let failed = false;
  return new Proxy(sql, {
    get: (target, property) => {
      if (property === 'begin') {
        return async (work: (tx: SQL) => Promise<unknown>) =>
          target.begin(async (tx) =>
            work(
              new Proxy(tx, {
                apply: (query, receiver, args: [TemplateStringsArray, ...unknown[]]) => {
                  if (!failed && args[0].join('').includes('WITH RECURSIVE ancestry')) {
                    failed = true;
                    throw new Error('Injected link timeout');
                  }
                  return Reflect.apply(query, receiver, args);
                },
              }),
            ),
          );
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

describe('Codex projection', () => {
  beforeAll(startTestServer, 60_000);

  test.each([
    ['empty object', '{}'],
    ['response item', JSON.stringify(skillMessage())],
  ])(
    'a non-header child file leaves the main totals and path unchanged (%s)',
    async (_kind, first) => {
      await using h = await startHub();
      await nameSources(h);
      await upload(h, MAIN, rolloutPath());
      await projectTranscripts(h.db.sql);
      const before = await h.db.sql`SELECT * FROM insight.sessions WHERE harness = 'codex'`;
      await upload(h, first + FORK.slice(FORK.indexOf('\n')), rolloutPath(CHILD));
      await projectTranscripts(h.db.sql);
      expect(await h.db.sql`SELECT * FROM insight.sessions WHERE harness = 'codex'`).toEqual(
        before,
      );
      const [totals] = await h.db
        .sql`SELECT requests, input_tokens FROM insight.main_conversation_totals WHERE harness = 'codex'`;
      expect(Number(totals?.requests)).toBe(2);
      expect(Number(totals?.input_tokens)).toBe(120);
      expect([
        ...(await h.db.sql`SELECT * FROM insight.subagents WHERE harness = 'codex'`),
      ]).toEqual([]);
    },
  );

  test('an empty archive activates Claude Code but waits for a source before activating Codex', async () => {
    await using h = await startHub();
    const projected = await projectTranscripts(h.db.sql);
    expect(projected.switched).toEqual([{ harness: 'claude-code', version: 1 }]);
    expect([...(await h.db.sql`SELECT harness FROM current_parsers ORDER BY harness`)]).toEqual([
      { harness: 'claude-code' },
    ]);
  });

  test('nested ownership resolves even when parser continuation state is opaque', async () => {
    await using h = await startHub();
    await nameSources(h);
    const opaqueParser = {
      ...codexParser,
      parse: (input: Parameters<typeof codexParser.parse>[0]) => ({
        ...codexParser.parse(input),
        state: 'opaque-continuation',
      }),
    };
    const nestedGeneration = await upload(h, NESTED_FILE, rolloutPath(NESTED));
    await projectTranscripts(h.db.sql, { parsers: [opaqueParser] });
    await upload(h, FORK, rolloutPath(CHILD));
    await upload(h, MAIN, rolloutPath());
    await projectTranscripts(h.db.sql, { parsers: [opaqueParser] });
    const [progress] = await h.db
      .sql`SELECT session_id FROM parse_progress WHERE harness = 'codex' AND generation = ${nestedGeneration}::bigint`;
    expect(progress?.session_id).toBe(SESSION);
  });

  test('a duplicate Codex response cannot change its conversation or locator', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, MAIN, rolloutPath());
    await projectTranscripts(h.db.sql);
    const before = await h.db
      .sql`SELECT * FROM insight.requests WHERE harness = 'codex' AND request_id = 'resp-1'`;
    await upload(
      h,
      jsonl([
        meta({ id: NESTED }),
        turn('other-turn', 'gpt-5.4-mini'),
        usage('resp-1', 'other-turn', 8, NESTED),
      ]),
      rolloutPath(NESTED),
    );
    await projectTranscripts(h.db.sql);
    expect(
      await h.db
        .sql`SELECT * FROM insight.requests WHERE harness = 'codex' AND request_id = 'resp-1'`,
    ).toEqual(before);
  });

  // A price for gpt-5.4 whose window differs from the one MAIN's turns record.
  const GPT_PRICE = {
    cacheRead: 0.5,
    contextWindow: 400_000,
    input: 4,
    model: 'gpt-5.4',
    output: 20,
    validFrom: '2026-01-01',
  };

  test('a request reads the window its turn recorded, and its fill, over the price table window', async () => {
    await using h = await startHub();
    await nameSources(h);
    await syncPrices(h.db.sql, { bundled: [GPT_PRICE], configured: [] });
    await upload(h, MAIN, rolloutPath());
    await projectTranscripts(h.db.sql);

    const [request] = await h.db.sql`
      SELECT context_tokens, context_window, context_fill_percent
      FROM insight.requests WHERE harness = 'codex' AND request_id = 'resp-1'
    `;
    expect(Number(request?.context_window)).toBe(258_400);
    expect(Number(request?.context_fill_percent)).toBeCloseTo((100 * 100) / 258_400, 10);
  });

  test('a request costs its uncached input at the input price and its cached input as cache reads', async () => {
    await using h = await startHub();
    await nameSources(h);
    await syncPrices(h.db.sql, { bundled: [GPT_PRICE], configured: [] });
    await upload(
      h,
      jsonl([meta(), turn('t', 'gpt-5.4'), usage('priced', 't'), usage('unattributed', 'missing')]),
      rolloutPath(),
    );
    await projectTranscripts(h.db.sql);

    const rows: { cost_usd: string | null; request_id: string }[] = await h.db.sql`
      SELECT request_id, cost_usd FROM insight.requests WHERE harness = 'codex' ORDER BY request_id
    `;
    // 60 uncached input at 4, 20 output at 20, and 40 cached input at 0.5 per million.
    expect(
      rows.map((r) => [r.request_id, r.cost_usd === null ? null : Number(r.cost_usd)]),
    ).toEqual([
      ['priced', (60 * 4 + 20 * 20 + 40 * 0.5) / 1_000_000],
      ['unattributed', null],
    ]);
  });

  test('serve projects Codex through named sources into all insight views and rebuilds only Codex on a version bump', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, MAIN, rolloutPath());
    await upload(h, FORK, rolloutPath(CHILD));
    await upload(h, TOOLS, rolloutPath());
    await upload(
      h,
      claudeJsonl([assistant({ at: new Date(NOW).toISOString(), id: 'claude-response' })]),
      mainPath(),
      'claude-code',
    );

    expect((await projectTranscripts(h.db.sql)).failed).toEqual([]);
    const sessions = await h.db
      .sql`SELECT harness, session_id FROM insight.sessions ORDER BY harness`;
    expect(sessions.map((s: { harness: string }) => s.harness)).toEqual(['claude-code', 'codex']);
    const children = await h.db
      .sql`SELECT session_id, agent_id, parent_agent_id FROM insight.subagents WHERE harness = 'codex'`;
    expect(children).toEqual([{ agent_id: CHILD, parent_agent_id: null, session_id: SESSION }]);
    const requests = await h.db
      .sql`SELECT request_id, model, context_tokens, context_window FROM insight.requests WHERE harness = 'codex' ORDER BY request_id`;
    expect(
      requests.map((r: { context_tokens: string; context_window: string; request_id: string }) => [
        r.request_id,
        Number(r.context_tokens),
        Number(r.context_window),
      ]),
    ).toEqual([
      ['child-response', 100, 258_400],
      ['resp-1', 100, 258_400],
      ['resp-2', 100, 258_400],
    ]);
    const tools = await h.db
      .sql`SELECT kind, skill, skill_inferred FROM insight.tool_calls WHERE harness = 'codex'`;
    expect(
      tools.filter(
        (t: { kind: string; skill_inferred: boolean }) => t.kind === 'tool' && !t.skill_inferred,
      ),
    ).toHaveLength(4);
    expect(tools.filter((t: { kind: string }) => t.kind === 'tool')).toHaveLength(6);
    expect(
      tools
        .filter((t: { skill: string | null }) => t.skill !== null)
        .every((t: { skill_inferred: boolean }) => t.skill_inferred),
    ).toBe(true);
    await refreshSessionInsight(h.db.sql);
    const totals = await h.db
      .sql`SELECT requests, input_tokens, cache_read_tokens FROM insight.session_totals WHERE harness = 'codex'`;
    expect(
      totals.map((r: { cache_read_tokens: string; input_tokens: string; requests: string }) => [
        Number(r.requests),
        Number(r.input_tokens),
        Number(r.cache_read_tokens),
      ]),
    ).toEqual([[3, 180, 120]]);
    const main = await h.db
      .sql`SELECT requests FROM insight.main_conversation_totals WHERE harness = 'codex'`;
    expect(Number(main[0]?.requests)).toBe(2);
    const claudeBefore = await h.db
      .sql`SELECT * FROM projected_requests WHERE harness = 'claude-code'`;
    const rebuilt = await projectTranscripts(h.db.sql, {
      parsers: [{ ...codexParser, version: codexParser.version + 1 }],
    });
    expect(rebuilt.switched).toEqual([{ harness: 'codex', version: codexParser.version + 1 }]);
    expect(await h.db.sql`SELECT * FROM projected_requests WHERE harness = 'claude-code'`).toEqual(
      claudeBefore,
    );
    const versions = await h.db
      .sql`SELECT DISTINCT parser_version FROM insight.requests WHERE harness = 'codex'`;
    expect(versions).toEqual([{ parser_version: codexParser.version + 1 }]);
    const shown = await h.db
      .sql`SELECT row_to_json(t) AS fact FROM insight.tool_calls t WHERE harness = 'codex'`;
    expect(JSON.stringify(shown)).not.toContain('Mock instructions');
    expect(JSON.stringify(shown)).not.toContain('/mock/skills/');
    const definitions = await h.db
      .sql`SELECT definition FROM pg_views WHERE schemaname = 'insight'`;
    expect(JSON.stringify(definitions)).not.toContain('transcript_chunks');
  });

  test('nested children uploaded first resolve to one Session and keep that root when their file resumes', async () => {
    await using h = await startHub();
    await nameSources(h);
    const nestedGeneration = await upload(h, NESTED_FILE, rolloutPath(NESTED));
    await projectTranscripts(h.db.sql);
    await upload(h, FORK, rolloutPath(CHILD));
    await upload(h, MAIN, rolloutPath());
    // The same child arrives again after its parent: its stable thread key
    // must update the existing row even as its root Session changes.
    await upload(h, NESTED_FILE, rolloutPath(NESTED));
    await projectTranscripts(h.db.sql);
    const appended = await sendChunk(h.hub, nestedGeneration, {
      content: jsonl([usage('nested-response-2', 'nested-turn', 4, NESTED)]),
      offset: Buffer.byteLength(NESTED_FILE),
      token: 'laptop-token',
    });
    expect(appended.status).toBe(200);
    expect((await projectTranscripts(h.db.sql)).failed).toEqual([]);
    expect([
      ...(await h.db.sql`SELECT session_id FROM insight.sessions WHERE harness = 'codex'`),
    ]).toEqual([{ session_id: SESSION }]);
    expect([
      ...(await h.db
        .sql`SELECT session_id, agent_id, parent_agent_id, depth FROM insight.subagents WHERE harness = 'codex' ORDER BY agent_id`),
    ]).toEqual([
      { agent_id: CHILD, depth: 1, parent_agent_id: null, session_id: SESSION },
      { agent_id: NESTED, depth: 2, parent_agent_id: CHILD, session_id: SESSION },
    ]);
    await refreshSessionInsight(h.db.sql);
    const [total] = await h.db
      .sql`SELECT requests FROM insight.session_totals WHERE harness = 'codex'`;
    expect(Number(total?.requests)).toBe(5);
  });

  test('deleting a nested child hides the whole Session until surviving generations are rederived', async () => {
    await using h = await startHub();
    await nameSources(h);
    const nestedGeneration = await upload(h, NESTED_FILE, rolloutPath(NESTED));
    await upload(h, FORK, rolloutPath(CHILD));
    await upload(h, MAIN, rolloutPath());
    await projectTranscripts(h.db.sql);
    await h.db
      .sql`UPDATE transcript_generations SET last_upload_at = ${new Date(NOW - 86_400_000)} WHERE id = ${nestedGeneration}::bigint`;
    await deleteTranscripts(h.db.sql, { before: NOW, now: NOW, source: 'coding' });
    expect([...(await h.db.sql`SELECT * FROM insight.sessions WHERE harness = 'codex'`)]).toEqual(
      [],
    );
    expect((await projectTranscripts(h.db.sql)).failed).toEqual([]);
    expect([
      ...(await h.db.sql`SELECT agent_id FROM insight.subagents WHERE harness = 'codex'`),
    ]).toEqual([{ agent_id: CHILD }]);
    await refreshSessionInsight(h.db.sql);
    const [total] = await h.db
      .sql`SELECT requests FROM insight.session_totals WHERE harness = 'codex'`;
    expect(Number(total?.requests)).toBe(3);
  });

  test('a linker failure during deletion rolls back generation marks and projected facts together', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, NESTED_FILE, rolloutPath(NESTED));
    await upload(h, FORK, rolloutPath(CHILD));
    await upload(h, MAIN, rolloutPath());
    await projectTranscripts(h.db.sql);
    const before = await h.db.sql`SELECT * FROM insight.requests ORDER BY request_id`;
    const error = await deleteTranscripts(linkFailsOnce(h.db.sql), {
      now: NOW,
      source: 'coding',
    }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error instanceof Error ? error.message : null).toBe('Injected link timeout');
    expect(await h.db.sql`SELECT * FROM insight.requests ORDER BY request_id`).toEqual(before);
    const [deleted] = await h.db
      .sql`SELECT count(*)::int AS n FROM transcript_generations WHERE deleted_at IS NOT NULL`;
    expect(deleted?.n).toBe(0);
  });

  test('a hierarchy link that failed after batches committed is retried without another upload', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, NESTED_FILE, rolloutPath(NESTED));
    await projectTranscripts(h.db.sql);
    await upload(h, FORK, rolloutPath(CHILD));
    await upload(h, MAIN, rolloutPath());
    const error = await projectTranscripts(linkFailsOnce(h.db.sql)).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error instanceof Error ? error.message : null).toBe('Injected link timeout');
    expect((await projectTranscripts(h.db.sql)).pending).toBe(0);
    await refreshSessionInsight(h.db.sql);
    const [total] = await h.db
      .sql`SELECT requests FROM insight.session_totals WHERE harness = 'codex'`;
    expect(Number(total?.requests)).toBe(4);
    expect([
      ...(await h.db
        .sql`SELECT DISTINCT session_id FROM insight.subagents WHERE harness = 'codex'`),
    ]).toEqual([{ session_id: SESSION }]);
  });
});
