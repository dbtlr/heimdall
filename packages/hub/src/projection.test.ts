import { describe, expect, test } from 'bun:test';

import { SQL } from 'bun';

import { claudeCodeParser } from './claude-code-parser.ts';
import { PARSE_BUDGET_BYTES, projectionNotes, projectTranscripts } from './projection.ts';
import {
  agentMeta,
  agentPath,
  assistant,
  costState,
  jsonl,
  mainPath,
  SESSION,
  user,
} from './testing/claude-code.ts';
import type { ModelUsage } from './testing/claude-code.ts';
import { gzip, NOW, openGeneration, push, report, sendChunk, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { deleteTranscripts } from './transcripts.ts';

const at = (second: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, second)).toISOString();

// A Session with a model switch, a response streamed over several lines, an
// interrupted one, a subagent that starts one of its own, and a workflow
// agent. Its cost-state is Claude Code's own running total, written out by
// hand: what the projection's totals must match.
const COST = {
  'claude-haiku-5-5': {
    cacheCreationInputTokens: 500,
    cacheReadInputTokens: 500,
    inputTokens: 11,
    outputTokens: 100,
  },
  'claude-opus-5-5': {
    cacheCreationInputTokens: 250,
    cacheReadInputTokens: 1000,
    inputTokens: 5,
    outputTokens: 300,
  },
  'claude-sonnet-5-5': {
    cacheCreationInputTokens: 1000,
    cacheReadInputTokens: 1500,
    inputTokens: 20,
    outputTokens: 167,
  },
} satisfies Record<string, ModelUsage>;

// A second Session.
const OTHER = '0b1c2d3e-0000-4000-8000-000000000002';

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';

const MAIN = jsonl([
  user({ at: at(0), cwd: '/w/start', version: '2.1.290' }),
  assistant({
    at: at(1),
    block: { kind: 'thinking' },
    id: 'msg_a',
    stop: null,
    usage: { cacheWrite5m: 1000, input: 10, output: 2 },
  }),
  assistant({
    at: at(2),
    id: 'msg_a',
    stop: null,
    usage: { cacheWrite5m: 1000, input: 10, output: 2 },
  }),
  assistant({
    at: at(3),
    block: { id: 'toolu_spawn', input: { subagent_type: 'Explore' }, kind: 'tool', name: 'Agent' },
    id: 'msg_a',
    stop: 'tool_use',
    usage: { cacheWrite5m: 1000, input: 10, output: 120 },
  }),
  assistant({
    at: at(20),
    id: 'msg_b',
    model: OPUS,
    usage: {
      cacheRead: 1000,
      cacheWrite1h: 50,
      cacheWrite5m: 200,
      input: 5,
      output: 300,
      thinking: 100,
    },
  }),
  assistant({
    at: at(21),
    id: 'msg_c',
    stop: null,
    usage: { cacheRead: 1200, input: 4, output: 1 },
  }),
  assistant({
    at: at(22),
    id: 'msg_c',
    stop: null,
    usage: { cacheRead: 1200, input: 4, output: 7 },
  }),
  assistant({ at: at(23), id: 'msg_synthetic', model: '<synthetic>' }),
  user({ at: at(30), command: '/review', cwd: '/w/end', uuid: 'u-review', version: '2.1.291' }),
  costState({ models: COST }),
]);

const SUBAGENT = jsonl([
  user({ agent: 's1', at: at(4) }),
  assistant({
    agent: 's1',
    at: at(5),
    block: { id: 'toolu_read', kind: 'tool', name: 'Read' },
    id: 'msg_s1',
    model: HAIKU,
    stop: null,
    usage: { cacheWrite5m: 500, input: 8, output: 3 },
  }),
  assistant({
    agent: 's1',
    at: at(6),
    id: 'msg_s1',
    model: HAIKU,
    usage: { cacheWrite5m: 500, input: 8, output: 60 },
  }),
  assistant({
    agent: 's1',
    at: at(7),
    block: { id: 'toolu_docs', kind: 'tool', name: 'mcp__docs__search' },
    id: 'msg_s2',
    model: HAIKU,
    stop: null,
    usage: { cacheRead: 500, input: 2, output: 30 },
  }),
  assistant({
    agent: 's1',
    at: at(8),
    block: { id: 'toolu_nested', kind: 'tool', name: 'Agent' },
    id: 'msg_s2',
    model: HAIKU,
    stop: 'tool_use',
    usage: { cacheRead: 500, input: 2, output: 30 },
  }),
]);

const NESTED = jsonl([
  assistant({
    agent: 's2',
    at: at(9),
    id: 'msg_n1',
    model: HAIKU,
    usage: { input: 1, output: 10 },
  }),
]);

const WORKFLOW_AGENT = jsonl([
  assistant({
    agent: 'w1',
    at: at(10),
    id: 'msg_w1',
    usage: { cacheRead: 300, input: 6, output: 40 },
  }),
]);

const SESSION_FILES = [
  { content: MAIN, path: mainPath() },
  { content: SUBAGENT, path: agentPath('s1') },
  {
    content: agentMeta({ agentType: 'Explore', toolUseId: 'toolu_spawn' }),
    path: agentPath('s1', { meta: true }),
  },
  { content: NESTED, path: agentPath('s2') },
  {
    content: agentMeta({ agentType: 'general-purpose', spawnDepth: 2, toolUseId: 'toolu_nested' }),
    path: agentPath('s2', { meta: true }),
  },
  { content: WORKFLOW_AGENT, path: agentPath('w1', { workflow: 'wf_run1' }) },
  {
    content: agentMeta({ agentType: 'workflow-subagent', workflowPhase: 'Implement' }),
    path: agentPath('w1', { meta: true, workflow: 'wf_run1' }),
  },
  // A workflow's journal records its phases and carries no usage.
  {
    content: '{"type":"phase","phase":"Implement"}\n',
    path: `projects/p/${SESSION}/subagents/workflows/wf_run1/journal.jsonl`,
  },
];

// Tells the Hub which Harness each of the laptop's sources runs, as every
// Report does (ADR-0013).
const nameSources = async (
  h: Hub,
  sources = [{ harness: 'claude-code', name: 'claude-code' }],
  { sentAt = NOW }: { sentAt?: number } = {},
) => {
  const transcripts = {
    sources: sources.map((source) => ({ ...source, status: 'capturing' })),
    spool: { bytes: 0, oldestAt: null },
  };
  const response = await push(
    h.hub,
    { ...report('laptop-1', [NOW]), sentAt, transcripts },
    { token: 'laptop-token' },
  );
  expect(response.status).toBe(200);
};

// Uploads a file as the laptop's Collector does, in chunks of at most
// `chunkBytes` that end on line boundaries, and answers its generation.
const upload = async (
  h: Hub,
  {
    chunkBytes = 1 << 20,
    content,
    path,
    source = 'claude-code',
  }: { chunkBytes?: number; content: string; path: string; source?: string },
) => {
  const opened = await openGeneration(h.hub, { path, source }, { token: 'laptop-token' });
  expect(opened.status).toBe(201);
  const { generation } = (await opened.json()) as { generation: number };
  await append(h, generation, { chunkBytes, content, offset: 0 });
  return generation;
};

const append = async (
  h: Hub,
  generation: number,
  {
    chunkBytes = 1 << 20,
    content,
    offset,
  }: { chunkBytes?: number; content: string; offset: number },
) => {
  let position = offset;
  for (const chunk of chunksOf(content, chunkBytes)) {
    // oxlint-disable-next-line no-await-in-loop -- chunks go in order, as the Collector sends them.
    const response = await sendChunk(h.hub, generation, {
      content: chunk,
      offset: position,
      token: 'laptop-token',
    });
    expect(response.status).toBe(200);
    position += Buffer.byteLength(chunk);
  }
  return position;
};

// Splits content as the Collector does: on line boundaries, and a line longer
// than a chunk into pieces. Synthetic content is ASCII, so a character is a byte.
const chunksOf = (content: string, chunkBytes: number) => {
  const chunks: string[] = [];
  let chunk = '';
  const pieces = content
    .split(/(?<=\n)/u)
    .flatMap((line) =>
      Array.from({ length: Math.ceil(line.length / chunkBytes) }, (_, i) =>
        line.slice(i * chunkBytes, (i + 1) * chunkBytes),
      ),
    );
  for (const line of pieces) {
    if (chunk !== '' && Buffer.byteLength(chunk + line) > chunkBytes) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += line;
  }
  return chunk === '' ? chunks : [...chunks, chunk];
};

const uploadSession = async (h: Hub) => {
  for (const file of SESSION_FILES) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time, like a scan.
    await upload(h, { ...file, chunkBytes: 600 });
  }
};

// Runs the projection until it has nothing left to parse.
const projectAll = async (h: Hub, options: Parameters<typeof projectTranscripts>[1] = {}) => {
  for (let tick = 0; tick < 100; tick += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each tick picks up where the last stopped.
    const outcome = await projectTranscripts(h.db.sql, options);
    if (outcome.pending === 0) {
      return;
    }
  }
  throw new Error('The projection never finished.');
};

const numbers = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value,
    ]),
  );

const requests = async (sql: SQL) => {
  const rows: Record<string, unknown>[] = await sql`
    SELECT session_id, agent_id, request_id, model, input_tokens, output_tokens, reasoning_tokens,
           cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
           context_tokens, stop_reason
    FROM insight.requests ORDER BY request_id
  `;
  return rows.map(numbers);
};

const TOTALS = `requests, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
  cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens`;

const totals = async (sql: SQL, view: 'main_conversation_totals' | 'session_totals') => {
  const rows: Record<string, unknown>[] = await sql.unsafe(
    `SELECT session_id, ${TOTALS} FROM insight.${view} ORDER BY session_id`,
  );
  return rows.map(numbers);
};

// `sql` as the projection sees it, except that `before` runs, and is awaited,
// ahead of each transaction the projection opens: the moment after a batch is
// read and before it is stored, where another connection's work can land.
const beforeEachTransaction = (sql: SQL, before: () => Promise<void>): SQL =>
  new Proxy(sql, {
    get: (target, property) => {
      if (property === 'begin') {
        return async (...args: Parameters<SQL['begin']>) => {
          await before();
          return target.begin(...args);
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

// `sql` as the projection sees it, except that `during` runs, and is awaited,
// after each transaction's work and before it commits: while the transaction
// holds every lock it took.
const beforeEachCommit = (sql: SQL, during: () => Promise<void>): SQL =>
  new Proxy(sql, {
    get: (target, property) => {
      if (property === 'begin') {
        return async (work: (tx: SQL) => Promise<unknown>) =>
          target.begin(async (tx) => {
            const done = await work(tx);
            await during();
            return done;
          });
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

// Waits until another session of the database waits on a lock.
const someoneWaitsOnALock = async (sql: SQL) => {
  for (let tries = 0; tries < 500; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls until the wait begins.
    const [row]: { n: number }[] = await sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
    `;
    if ((row?.n ?? 0) > 0) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polls until the wait begins.
    await Bun.sleep(10);
  }
  throw new Error('No session waited on a lock.');
};

// `sql` as the projection sees it, counting the rows of each query it runs
// outside a transaction, as reads of transcript chunks are.
const countingRows = (sql: SQL) => {
  let most = 0;
  const counted = new Proxy(sql, {
    apply: async (target, _, [strings, ...values]: [TemplateStringsArray, ...unknown[]]) => {
      const rows: unknown[] = await target(strings, ...values);
      most = Math.max(most, rows.length);
      return rows;
    },
    get: (target, property) => {
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.assign(counted, { mostRows: () => most });
};

const sessions = async (sql: SQL) => {
  const rows: Record<string, unknown>[] = await sql`
    SELECT session_id, path, started_at, ended_at, first_cwd, last_cwd,
           first_harness_version, last_harness_version, parser_version
    FROM insight.sessions ORDER BY session_id
  `;
  return rows;
};

describe('a Claude Code Session', () => {
  test("totals reconcile with the Harness's own cost-state", async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);

    await projectAll(h);

    const byModel: Record<string, ModelUsage> = {};
    for (const r of await requests(h.db.sql)) {
      const model = String(r.model);
      const sum = byModel[model] ?? {
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      byModel[model] = {
        cacheCreationInputTokens: sum.cacheCreationInputTokens + Number(r.cache_write_tokens),
        cacheReadInputTokens: sum.cacheReadInputTokens + Number(r.cache_read_tokens),
        inputTokens: sum.inputTokens + Number(r.input_tokens),
        outputTokens: sum.outputTokens + Number(r.output_tokens),
      };
    }
    expect(byModel).toEqual(COST);
  });

  test('totals count its subagents, and the main conversation alone without them', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);

    await projectAll(h);

    expect(await totals(h.db.sql, 'session_totals')).toEqual([
      {
        cache_read_tokens: 3000,
        cache_write_1h_tokens: 50,
        cache_write_5m_tokens: 1700,
        cache_write_tokens: 1750,
        input_tokens: 36,
        output_tokens: 567,
        reasoning_tokens: 100,
        requests: 7,
        session_id: SESSION,
      },
    ]);
    expect(await totals(h.db.sql, 'main_conversation_totals')).toEqual([
      {
        cache_read_tokens: 2200,
        cache_write_1h_tokens: 50,
        cache_write_5m_tokens: 1200,
        cache_write_tokens: 1250,
        input_tokens: 19,
        output_tokens: 427,
        reasoning_tokens: 100,
        requests: 3,
        session_id: SESSION,
      },
    ]);
  });

  test('spans its earliest and latest lines, with where it ran at each', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);

    await projectAll(h);

    expect(await sessions(h.db.sql)).toEqual([
      {
        ended_at: new Date(at(30)),
        first_cwd: '/w/start',
        first_harness_version: '2.1.290',
        last_cwd: '/w/end',
        last_harness_version: '2.1.291',
        parser_version: 1,
        path: mainPath(),
        session_id: SESSION,
        started_at: new Date(at(0)),
      },
    ]);
  });

  test('each request keeps its model, its final usage, and its context fill', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);

    await projectAll(h);

    const main = (await requests(h.db.sql)).filter((r) => r.agent_id === null);
    expect(main).toEqual([
      expect.objectContaining({
        context_tokens: 1010,
        model: SONNET,
        output_tokens: 120,
        request_id: 'msg_a',
        stop_reason: 'tool_use',
      }),
      expect.objectContaining({
        context_tokens: 1255,
        model: OPUS,
        reasoning_tokens: 100,
        request_id: 'msg_b',
      }),
      expect.objectContaining({
        context_tokens: 1204,
        output_tokens: 7,
        request_id: 'msg_c',
        stop_reason: null,
      }),
    ]);
  });

  test('subagents link to the conversation that spawned them, and workflow agents to their run', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);

    await projectAll(h);

    const subagents: unknown[] = await h.db.sql`
      SELECT agent_id, parent_agent_id, agent_type, depth, tool_use_id, workflow_run, workflow_phase,
             path, started_at, ended_at
      FROM insight.subagents ORDER BY agent_id
    `;
    expect(subagents).toEqual([
      {
        agent_id: 's1',
        agent_type: 'Explore',
        depth: 1,
        ended_at: new Date(at(8)),
        parent_agent_id: null,
        path: agentPath('s1'),
        started_at: new Date(at(4)),
        tool_use_id: 'toolu_spawn',
        workflow_phase: null,
        workflow_run: null,
      },
      expect.objectContaining({
        agent_id: 's2',
        depth: 2,
        parent_agent_id: 's1',
        tool_use_id: 'toolu_nested',
      }),
      expect.objectContaining({
        agent_id: 'w1',
        agent_type: 'workflow-subagent',
        parent_agent_id: null,
        tool_use_id: null,
        workflow_phase: 'Implement',
        workflow_run: 'wf_run1',
      }),
    ]);
  });

  test('tool calls name their tool, MCP server, or skill, with a locator into the archive', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);

    await projectAll(h);

    const calls = await h.db.sql`
      SELECT agent_id, call_id, kind, name, mcp_server, skill, path FROM insight.tool_calls ORDER BY call_id
    `;
    expect(calls).toEqual([
      expect.objectContaining({
        call_id: 'toolu_docs',
        mcp_server: 'docs',
        name: 'mcp__docs__search',
        path: agentPath('s1'),
      }),
      expect.objectContaining({ agent_id: 's1', call_id: 'toolu_nested', name: 'Agent' }),
      expect.objectContaining({ agent_id: 's1', call_id: 'toolu_read', name: 'Read' }),
      expect.objectContaining({
        agent_id: null,
        call_id: 'toolu_spawn',
        name: 'Agent',
        path: mainPath(),
      }),
      expect.objectContaining({
        call_id: 'u-review',
        kind: 'command',
        name: '/review',
        skill: null,
      }),
    ]);
  });

  // The locator's offset counts bytes of the file, so a reader can find the
  // line in the transcript the generation holds.
  test("a request's locator points at the line it was read from", async () => {
    await using h = await startHub();
    await nameSources(h);
    const generation = await upload(h, { chunkBytes: 600, content: MAIN, path: mainPath() });

    await projectAll(h);

    const [row] = await h.db.sql`
      SELECT generation, byte_offset FROM insight.requests WHERE request_id = 'msg_b'
    `;
    expect(Number(row?.generation)).toBe(generation);
    const line = Buffer.from(MAIN).subarray(Number(row?.byte_offset)).toString().split('\n')[0];
    expect(JSON.parse(line ?? '')).toMatchObject({ message: { id: 'msg_b' } });
  });
});

describe('parsing as transcripts grow', () => {
  // A response whose lines straddle two uploads is first seen partial.
  test('a response streamed across two ticks counts once, from its final line', async () => {
    await using h = await startHub();
    await nameSources(h);
    const first = jsonl([
      assistant({ at: at(1), id: 'msg_1', stop: null, usage: { input: 3, output: 1 } }),
    ]);
    const generation = await upload(h, { content: first, path: mainPath() });
    await projectAll(h);

    await append(h, generation, {
      content: jsonl([assistant({ at: at(2), id: 'msg_1', usage: { input: 3, output: 90 } })]),
      offset: Buffer.byteLength(first),
    });
    await projectAll(h);

    expect(await requests(h.db.sql)).toEqual([
      expect.objectContaining({ output_tokens: 90, request_id: 'msg_1', stop_reason: 'end_turn' }),
    ]);
  });

  // The Collector splits a line longer than its chunk limit (ADR-0013).
  test('a line split across chunks, and longer than the budget, is read whole', async () => {
    await using h = await startHub();
    await nameSources(h);
    const opened = await openGeneration(
      h.hub,
      { path: mainPath(), source: 'claude-code' },
      { token: 'laptop-token' },
    );
    const { generation } = (await opened.json()) as { generation: number };
    for (const [start, end] of [
      [0, 333],
      [333, 1500],
      [1500, MAIN.length],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- chunks go in order.
      const sent = await sendChunk(h.hub, generation, {
        content: MAIN.slice(start, end),
        offset: start,
        token: 'laptop-token',
      });
      expect(sent.status).toBe(200);
    }

    await projectAll(h, { budgetBytes: 50 });

    expect(await totals(h.db.sql, 'session_totals')).toEqual([
      expect.objectContaining({ input_tokens: 19, output_tokens: 427, requests: 3 }),
    ]);
  });

  // Whether the lines arrive in one batch or two, the first line of a call keeps it.
  test('a command line written twice under one uuid derives the same call in pieces as whole', async () => {
    const first = jsonl([user({ at: at(0), command: '/review', uuid: 'u-1' })]);
    const second = jsonl([user({ at: at(5), command: '/review', uuid: 'u-1' })]);
    const calls = async (inPieces: boolean) => {
      await using h = await startHub();
      await nameSources(h);
      const generation = await upload(h, { content: first, path: mainPath() });
      if (inPieces) {
        await projectAll(h);
      }
      await append(h, generation, { content: second, offset: Buffer.byteLength(first) });
      await projectAll(h);
      return [...(await h.db.sql`SELECT call_id, at, byte_offset FROM insight.tool_calls`)];
    };

    const whole = await calls(false);

    expect(whole).toEqual([{ at: new Date(at(0)), byte_offset: '0', call_id: 'u-1' }]);
    expect(await calls(true)).toEqual(whole);
  });

  // Claude Code can write a partial line after the final one, and a later
  // batch must not undo the final usage.
  test('a partial line read after the final one leaves the final usage', async () => {
    await using h = await startHub();
    await nameSources(h);
    const first = jsonl([assistant({ at: at(1), id: 'msg_1', usage: { input: 3, output: 90 } })]);
    const generation = await upload(h, { content: first, path: mainPath() });
    await projectAll(h);

    await append(h, generation, {
      content: jsonl([assistant({ at: at(2), id: 'msg_1', stop: null, usage: { output: 1 } })]),
      offset: Buffer.byteLength(first),
    });
    await projectAll(h);

    expect(await requests(h.db.sql)).toEqual([
      expect.objectContaining({ output_tokens: 90, stop_reason: 'end_turn' }),
    ]);
  });

  test('a Session ends where its later batch does when two lines share a moment', async () => {
    await using h = await startHub();
    await nameSources(h);
    const first = jsonl([user({ at: at(0), cwd: '/w/a' }), user({ at: at(5), cwd: '/w/b' })]);
    const generation = await upload(h, { content: first, path: mainPath() });
    await projectAll(h);

    await append(h, generation, {
      content: jsonl([user({ at: at(5), cwd: '/w/c' })]),
      offset: Buffer.byteLength(first),
    });
    await projectAll(h);

    expect(await sessions(h.db.sql)).toEqual([expect.objectContaining({ last_cwd: '/w/c' })]);
  });

  // A line past the cap is skipped as it is read, never held whole.
  test.each([
    ['in one read', PARSE_BUDGET_BYTES],
    ['over several reads', 2 ** 20],
  ])(
    'a line longer than 16 MiB is counted unreadable and skipped, %s',
    async (_, budgetBytes) => {
      await using h = await startHub();
      await nameSources(h);
      const huge = {
        ...user({ at: at(0) }),
        message: { content: 'x'.repeat(40 * 2 ** 20), role: 'user' },
      };
      await upload(h, {
        content: jsonl([huge, assistant({ at: at(1), id: 'msg_after', usage: { input: 3 } })]),
        path: mainPath(),
      });
      const sql = countingRows(h.db.sql);

      await projectAll({ ...h, db: { ...h.db, sql } }, { budgetBytes });

      expect(await settled(h.db.sql)).toEqual({
        requests: ['msg_after'],
        sessions: [SESSION],
        status: [{ failed_generations: 0, generations: 1, unreadable_lines: 1 }],
      });
      // Chunks are 1 MiB, so no read held the line whole.
      expect(sql.mostRows()).toBeLessThan(Math.max(budgetBytes / 2 ** 20, 32) + 2);
    },
    60_000,
  );

  // ADR-0013 can store a file twice, as after a Collector's state is wiped.
  test('a request two generations both hold counts once', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: MAIN, path: mainPath() });
    await upload(h, { content: MAIN, path: mainPath() });

    await projectAll(h);

    expect(await totals(h.db.sql, 'session_totals')).toEqual([
      expect.objectContaining({ input_tokens: 19, output_tokens: 427, requests: 3 }),
    ]);
  });

  test('a source whose Harness the Hub has no parser for is left unparsed', async () => {
    await using h = await startHub();
    await nameSources(h, [{ harness: 'codex', name: 'claude-code' }]);
    await upload(h, { content: MAIN, path: mainPath() });

    await projectAll(h);

    expect(await sessions(h.db.sql)).toEqual([]);
  });

  test('a source removed from the configuration keeps its Harness', async () => {
    await using h = await startHub();
    await nameSources(h, [{ harness: 'claude-code', name: 'work' }]);
    await upload(h, { content: MAIN, path: mainPath(), source: 'work' });
    await nameSources(h, []);

    await projectAll(h);

    expect(await sessions(h.db.sql)).toEqual([expect.objectContaining({ session_id: SESSION })]);
  });

  // Progress is each Harness's own, so another Harness's parser at the same
  // version number reads the source afresh.
  test('a source that changes Harness is parsed again by the new Harness', async () => {
    await using h = await startHub();
    await nameSources(h, undefined, { sentAt: NOW - 60_000 });
    await upload(h, { content: MAIN, path: mainPath() });
    await projectAll(h);
    await nameSources(h, [{ harness: 'codex', name: 'claude-code' }]);
    const codex = { ...claudeCodeParser, harness: 'codex' };

    await projectAll(h, { parsers: [codex] });

    const harnesses = await h.db.sql`SELECT harness FROM insight.sessions ORDER BY harness`;
    expect([...harnesses]).toEqual([{ harness: 'claude-code' }, { harness: 'codex' }]);
  });

  // Reports can arrive out of order; the latest one sent names the Harness.
  test("a Report sent earlier than the one the Hub holds leaves a source's Harness alone", async () => {
    await using h = await startHub();
    await nameSources(h);
    await nameSources(h, [{ harness: 'codex', name: 'claude-code' }], { sentAt: NOW - 60_000 });
    await upload(h, { content: MAIN, path: mainPath() });

    await projectAll(h);

    expect(await sessions(h.db.sql)).toEqual([expect.objectContaining({ session_id: SESSION })]);
  });

  test('a source no Report has named waits until one does', async () => {
    await using h = await startHub();
    await upload(h, { content: MAIN, path: mainPath(), source: 'work' });
    await projectAll(h);
    expect(await sessions(h.db.sql)).toEqual([]);

    await nameSources(h, [{ harness: 'claude-code', name: 'work' }]);
    await projectAll(h);

    expect(await sessions(h.db.sql)).toEqual([expect.objectContaining({ session_id: SESSION })]);
  });
});

// What the views show of each Session, and how well the current parser read
// what the Hub holds.
const settled = async (sql: SQL) => ({
  requests: (await requests(sql)).map((r) => r.request_id),
  sessions: (await sessions(sql)).map((s) => s.session_id),
  status: (
    await sql`SELECT generations, failed_generations, unreadable_lines FROM insight.parse_status`
  ).map(numbers),
});

describe('a generation the projection cannot read', () => {
  const sessionOf = (session = SESSION) =>
    jsonl([
      user({ at: at(0), session }),
      assistant({
        at: at(1),
        id: session === SESSION ? 'msg_main' : `msg_${session}`,
        session,
        usage: { input: 5 },
      }),
    ]);

  // Each line PostgreSQL would refuse, were it stored as written.
  test.each([
    ['a NUL in its directory', { ...user({ at: at(2) }), cwd: 'a\0b' }, ['msg_main']],
    ['a time before the year 1', user({ at: '-005000-01-01T00:00:00.000Z' }), ['msg_main']],
    ['a 43 KB response id', assistant({ at: at(2), id: 'm'.repeat(43_000) }), ['msg_main']],
    ['a 3 MB command', user({ at: at(2), command: `/${'x'.repeat(3_000_000)}` }), ['msg_main']],
  ])('with %s leaves every other line and generation shown', async (_, line, kept) => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: sessionOf(OTHER), path: mainPath(OTHER) });
    await upload(h, { content: sessionOf() + jsonl([line]), path: mainPath() });

    await projectAll(h);

    const shown = await settled(h.db.sql);
    expect(shown.requests).toEqual([...kept, `msg_${OTHER}`].toSorted());
    expect(shown.sessions).toEqual([SESSION, OTHER].toSorted());
  });

  test.each([
    [
      'a damaged gzip chunk',
      (sql: SQL, g: number) => sql`
      UPDATE transcript_chunks SET content = ${Buffer.from('not gzip')} WHERE generation = ${g}::bigint
    `,
    ],
    [
      'a chunk shorter than it was stored as',
      async (sql: SQL, g: number) => {
        const shorter = await gzip('{}\n');
        await sql`UPDATE transcript_chunks SET content = ${shorter} WHERE generation = ${g}::bigint`;
      },
    ],
    [
      'a gap between its chunks',
      (sql: SQL, g: number) => sql`
      UPDATE transcript_chunks SET offset_bytes = offset_bytes + 7
      WHERE generation = ${g}::bigint AND offset_bytes > 0
    `,
    ],
    [
      'a gap at its start',
      (sql: SQL, g: number) => sql`
      DELETE FROM transcript_chunks WHERE generation = ${g}::bigint AND offset_bytes = 0
    `,
    ],
  ])('with %s is recorded failed, and the views switch without it', async (_, damage) => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: sessionOf(OTHER), path: mainPath(OTHER) });
    const damaged = await upload(h, { chunkBytes: 100, content: sessionOf(), path: mainPath() });
    await damage(h.db.sql, damaged);

    await projectAll(h);
    const again = await projectTranscripts(h.db.sql);

    expect(await settled(h.db.sql)).toEqual({
      requests: [`msg_${OTHER}`],
      sessions: [OTHER],
      status: [{ failed_generations: 1, generations: 2, unreadable_lines: 0 }],
    });
    // A failed generation is not read again until the next version.
    expect(again.failed).toEqual([]);
  });

  test('that the database refuses to store is recorded failed, and the views switch without it', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: sessionOf(OTHER), path: mainPath(OTHER) });
    await upload(h, { content: sessionOf(), path: mainPath() });
    // A parser that lets through what the database refuses.
    const careless = {
      ...claudeCodeParser,
      parse: (input: Parameters<typeof claudeCodeParser.parse>[0]) => {
        const batch = claudeCodeParser.parse(input);
        return input.path === mainPath()
          ? { ...batch, requests: batch.requests.map((r) => ({ ...r, input: 2 ** 70 })) }
          : batch;
      },
    };

    await projectAll(h, { parsers: [careless] });

    expect(await settled(h.db.sql)).toEqual({
      requests: [`msg_${OTHER}`],
      sessions: [OTHER],
      status: [{ failed_generations: 1, generations: 2, unreadable_lines: 0 }],
    });
  });

  test('is parsed again by the next parser version', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: sessionOf(), path: mainPath() });
    const failing = {
      ...claudeCodeParser,
      parse: () => {
        throw Object.assign(new Error('Synthetic data error.'), { errno: '22003' });
      },
    };
    await projectAll(h, { parsers: [failing] });

    await projectAll(h, { parsers: [{ ...claudeCodeParser, version: 2 }] });

    expect(await settled(h.db.sql)).toEqual({
      requests: ['msg_main'],
      sessions: [SESSION],
      status: [{ failed_generations: 0, generations: 1, unreadable_lines: 0 }],
    });
  });

  test('counts the lines it could not read', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: `{"type":\n${sessionOf()}`, path: mainPath() });

    await projectAll(h);

    expect((await settled(h.db.sql)).status).toEqual([
      { failed_generations: 0, generations: 1, unreadable_lines: 1 },
    ]);
  });
});

describe('deleting transcripts', () => {
  test("removes the facts derived from a generation's Session", async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);
    await projectAll(h);

    await deleteTranscripts(h.db.sql, { now: NOW, system: 'laptop-1' });

    expect(await sessions(h.db.sql)).toEqual([]);
    expect(await requests(h.db.sql)).toEqual([]);
    const calls: unknown[] = await h.db.sql`SELECT * FROM insight.tool_calls`;
    const subagents: unknown[] = await h.db.sql`SELECT * FROM insight.subagents`;
    expect([calls, subagents]).toEqual([[], []]);
  });

  // The projection is always what the surviving archive yields (ADR-0014).
  test('re-derives a Session from the generation that still holds it', async () => {
    await using h = await startHub();
    await nameSources(h);
    const old = await upload(h, { content: MAIN, path: mainPath() });
    await projectAll(h);
    const newer = await upload(h, { content: MAIN, path: mainPath() });
    await projectAll(h);
    await h.db
      .sql`UPDATE transcript_generations SET last_upload_at = ${new Date(NOW - 86_400_000)} WHERE id = ${old}`;

    await deleteTranscripts(h.db.sql, { before: NOW - 3_600_000, now: NOW });
    await projectAll(h);

    expect(await totals(h.db.sql, 'session_totals')).toEqual([
      expect.objectContaining({ input_tokens: 19, output_tokens: 427, requests: 3 }),
    ]);
    const generations = await h.db.sql`SELECT DISTINCT generation FROM insight.requests`;
    expect(generations.map((row: { generation: string }) => Number(row.generation))).toEqual([
      newer,
    ]);
  });
});

const subagentOf = (id: string) =>
  jsonl([assistant({ agent: 'a1', at: at(50), id, usage: { input: 1000 } })]);

// Makes a generation a day old, so `deleteOld` deletes it and no other.
const ageGeneration = (h: Hub, generation: number) =>
  h.db
    .sql`UPDATE transcript_generations SET last_upload_at = ${new Date(NOW - 86_400_000)} WHERE id = ${generation}`;

const deleteOld = (h: Hub) => deleteTranscripts(h.db.sql, { before: NOW - 3_600_000, now: NOW });

describe('deriving a Session again after a delete', () => {
  const FORTY = jsonl(
    Array.from({ length: 40 }, (_, i) =>
      assistant({ at: at(i), id: `msg_${String(i)}`, usage: { input: 1 } }),
    ),
  );

  test('hides the Session until it is derived again whole', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { chunkBytes: 400, content: FORTY, path: mainPath() });
    const old = await upload(h, { content: subagentOf('msg_a'), path: agentPath('a1') });
    await projectAll(h);
    await ageGeneration(h, old);

    await deleteOld(h);
    const afterDelete = await totals(h.db.sql, 'session_totals');
    await projectTranscripts(h.db.sql, { budgetBytes: 2000 });
    const afterOneRun = await totals(h.db.sql, 'session_totals');
    await projectAll(h);

    expect([afterDelete, afterOneRun]).toEqual([[], []]);
    expect(await totals(h.db.sql, 'session_totals')).toEqual([
      expect.objectContaining({ input_tokens: 40, requests: 40 }),
    ]);
  });

  test('leaves a live Session shown as it grows', async () => {
    await using h = await startHub();
    await nameSources(h);
    const first = jsonl([assistant({ at: at(0), id: 'msg_first', usage: { input: 1 } })]);
    const generation = await upload(h, { content: first, path: mainPath() });
    await projectAll(h);
    await append(h, generation, {
      chunkBytes: 400,
      content: FORTY,
      offset: Buffer.byteLength(first),
    });

    await projectTranscripts(h.db.sql, { budgetBytes: 2000 });

    const [shown] = await totals(h.db.sql, 'session_totals');
    expect(shown?.requests).toBeGreaterThan(1);
    expect(shown?.requests).toBeLessThan(41);
  });

  // The request is kept with the Session parsed last, so deleting that
  // Session's generation must derive the other holder again.
  test('keeps a request another Session still holds', async () => {
    await using h = await startHub();
    await nameSources(h);
    const shared = assistant({ at: at(1), id: 'msg_shared', usage: { input: 5, output: 7 } });
    await upload(h, { content: jsonl([user({ at: at(0) }), shared]), path: mainPath() });
    await projectAll(h);
    const later = await upload(h, {
      content: jsonl([user({ at: at(0), session: OTHER }), { ...shared, sessionId: OTHER }]),
      path: mainPath(OTHER),
    });
    await projectAll(h);
    const before = await h.db.sql`SELECT session_id FROM insight.requests`;
    await ageGeneration(h, later);

    await deleteOld(h);
    await projectAll(h);

    expect([...before]).toEqual([{ session_id: OTHER }]);
    const after = await h.db.sql`SELECT session_id, request_id FROM insight.requests`;
    expect([...after]).toEqual([{ request_id: 'msg_shared', session_id: SESSION }]);
  });

  test('keeps a tool call another Session still holds', async () => {
    await using h = await startHub();
    await nameSources(h);
    // The first line read keeps a tool call, so the Session parsed first holds it.
    const command = user({ at: at(0), command: '/review', uuid: 'u-shared' });
    const earlier = await upload(h, {
      content: jsonl([{ ...command, sessionId: OTHER }]),
      path: mainPath(OTHER),
    });
    await projectAll(h);
    await upload(h, { content: jsonl([command]), path: mainPath() });
    await projectAll(h);
    await ageGeneration(h, earlier);

    await deleteOld(h);
    await projectAll(h);

    const after = await h.db.sql`SELECT session_id, call_id FROM insight.tool_calls`;
    expect([...after]).toEqual([{ call_id: 'u-shared', session_id: SESSION }]);
  });

  // A generation recorded failed is not read again until the next version,
  // so it must not keep its Session hidden.
  test('shows the Session again once every generation of it is parsed or failed', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: FORTY, path: mainPath() });
    const old = await upload(h, { content: subagentOf('msg_a'), path: agentPath('a1') });
    const damaged = await upload(h, { content: subagentOf('msg_b'), path: agentPath('a2') });
    await projectAll(h);
    await ageGeneration(h, old);

    await deleteOld(h);
    await h.db.sql`
      UPDATE transcript_chunks SET content = ${Buffer.from('not gzip')}
      WHERE generation = ${damaged}::bigint
    `;
    await projectAll(h);

    expect(await totals(h.db.sql, 'session_totals')).toEqual([
      expect.objectContaining({ input_tokens: 40, requests: 40 }),
    ]);
  });
});

describe('deleting transcripts while a batch is read', () => {
  // A delete resets the progress of every generation of the Sessions it
  // touches, so a batch read before it from further on must not be stored.
  test('drops the batch, and the Session is derived again whole', async () => {
    await using h = await startHub();
    await nameSources(h);
    const first = jsonl([
      user({ at: at(0) }),
      assistant({ at: at(1), id: 'msg_1', usage: { input: 100 } }),
    ]);
    const live = await upload(h, { content: first, path: mainPath() });
    const old = await upload(h, {
      content: jsonl([assistant({ agent: 'a1', at: at(2), id: 'msg_a', usage: { input: 10 } })]),
      path: agentPath('a1'),
    });
    await projectAll(h);
    await append(h, live, {
      content: jsonl([assistant({ at: at(3), id: 'msg_2', usage: { input: 1 } })]),
      offset: Buffer.byteLength(first),
    });
    await h.db
      .sql`UPDATE transcript_generations SET last_upload_at = ${new Date(NOW - 86_400_000)} WHERE id = ${old}`;
    let armed = false;
    const racing = {
      ...claudeCodeParser,
      parse: (input: Parameters<typeof claudeCodeParser.parse>[0]) => {
        armed ||= input.offset > 0;
        return claudeCodeParser.parse(input);
      },
    };
    const sql = beforeEachTransaction(h.db.sql, async () => {
      if (armed) {
        armed = false;
        await deleteTranscripts(h.db.sql, { before: NOW - 3_600_000, now: NOW });
      }
    });

    await projectTranscripts(sql, { parsers: [racing] });
    await projectAll(h);

    expect(await totals(h.db.sql, 'session_totals')).toEqual([
      expect.objectContaining({ input_tokens: 101, requests: 2 }),
    ]);
  });

  // A delete that starts while a batch of its generation is being stored
  // must see what the batch stored, or the batch must find it gone.
  test('that starts while the batch is stored leaves nothing of the deleted generation', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, {
      content: jsonl([user({ at: at(0) }), assistant({ at: at(1), id: 'msg_main' })]),
      path: mainPath(),
    });
    const first = jsonl([assistant({ agent: 'a1', at: at(2), id: 'msg_old' })]);
    const subagent = await upload(h, { content: first, path: agentPath('a1') });
    await projectAll(h);
    await append(h, subagent, {
      content: jsonl([assistant({ agent: 'a1', at: at(3), id: 'msg_new' })]),
      offset: Buffer.byteLength(first),
    });
    await h.db.sql`
      UPDATE transcript_generations SET last_upload_at = ${new Date(NOW - 86_400_000)}
      WHERE id = ${subagent}::bigint
    `;
    let deleting: Promise<unknown> | undefined;
    const sql = beforeEachCommit(h.db.sql, async () => {
      if (deleting === undefined) {
        deleting = deleteTranscripts(h.db.sql, { before: NOW - 3_600_000, now: NOW });
        await someoneWaitsOnALock(h.db.sql);
      }
    });

    await projectTranscripts(sql);
    await deleting;
    await projectAll(h);

    expect((await requests(h.db.sql)).map((r) => r.request_id)).toEqual(['msg_main']);
    const left = await h.db.sql`
      SELECT request_id FROM projected_requests WHERE generation = ${subagent}::bigint
    `;
    expect([...left]).toEqual([]);
  });

  // A batch read before a delete that removed its generation stores nothing,
  // even before the next run tidies up.
  test('that removed the generation before its first batch is stored leaves the views without it', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, {
      content: jsonl([user({ at: at(0) }), assistant({ at: at(1), id: 'msg_main' })]),
      path: mainPath(),
    });
    await projectAll(h);
    const subagent = await upload(h, {
      content: jsonl([assistant({ agent: 'a1', at: at(2), id: 'msg_sub' })]),
      path: agentPath('a1'),
    });
    await h.db.sql`
      UPDATE transcript_generations SET last_upload_at = ${new Date(NOW - 86_400_000)}
      WHERE id = ${subagent}::bigint
    `;
    let deleted = false;
    const sql = beforeEachTransaction(h.db.sql, async () => {
      if (!deleted) {
        deleted = true;
        await deleteTranscripts(h.db.sql, { before: NOW - 3_600_000, now: NOW });
      }
    });

    await projectTranscripts(sql);

    expect((await requests(h.db.sql)).map((r) => r.request_id)).toEqual(['msg_main']);
  });
});

describe('a parser version change', () => {
  const nextVersion = { ...claudeCodeParser, version: claudeCodeParser.version + 1 };

  test('rebuilds while the views show the complete earlier set, then switches at once', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);
    await projectAll(h);
    const before = await totals(h.db.sql, 'session_totals');

    // A small budget spreads the rebuild over ticks, as a restart would interrupt it.
    const budget = { budgetBytes: 700, parsers: [nextVersion] };
    const first = await projectTranscripts(h.db.sql, budget);

    expect(first.pending).toBeGreaterThan(0);
    expect(await totals(h.db.sql, 'session_totals')).toEqual(before);
    expect((await sessions(h.db.sql)).map((s) => s.parser_version)).toEqual([1]);

    await projectAll(h, budget);

    expect(await totals(h.db.sql, 'session_totals')).toEqual(before);
    expect((await sessions(h.db.sql)).map((s) => s.parser_version)).toEqual([2]);
    const [left] = await h.db.sql`
      SELECT count(*)::int AS n FROM projected_requests WHERE parser_version = 1
    `;
    expect(left?.n).toBe(0);
  });

  // Two Hubs can share a database across an upgrade.
  test('a Hub with an older parser never switches back, and leaves the newer rows alone', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);
    await projectAll(h);
    const before = await totals(h.db.sql, 'session_totals');
    await projectAll(h, { parsers: [nextVersion] });

    const older = await projectTranscripts(h.db.sql);
    await projectTranscripts(h.db.sql, { parsers: [nextVersion] });
    await projectTranscripts(h.db.sql);

    expect(older).toEqual({
      failed: [],
      outdated: [{ current: 2, harness: 'claude-code', version: 1 }],
      pending: 0,
      switched: [],
    });
    expect((await sessions(h.db.sql)).map((s) => s.parser_version)).toEqual([2]);
    expect(await totals(h.db.sql, 'session_totals')).toEqual(before);
    const versions = await h.db.sql`
      SELECT DISTINCT parser_version FROM parse_progress ORDER BY parser_version
    `;
    expect([...versions]).toEqual([{ parser_version: 2 }]);
  });

  // The Hub that rebuilds parses only its own version, so the current set
  // stands still while uploads keep landing on it.
  test('switches once the new version has caught up with the current one, while uploads keep arriving', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);
    const live = await upload(h, { content: jsonl([user({ at: at(40) })]), path: mainPath(OTHER) });
    await projectAll(h);
    let offset = Buffer.byteLength(jsonl([user({ at: at(40) })]));
    let line = 0;
    const sql = beforeEachTransaction(h.db.sql, async () => {
      line += 1;
      offset = await append(h, live, {
        content: jsonl([user({ at: at(40 + (line % 20)), session: OTHER })]),
        offset,
      });
    });

    const outcomes = [];
    for (let run = 0; run < 3; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each run picks up where the last stopped.
      outcomes.push(await projectTranscripts(sql, { parsers: [nextVersion] }));
    }

    expect(outcomes.every((outcome) => outcome.pending > 0)).toBe(true);
    expect(outcomes.flatMap((outcome) => outcome.switched)).toEqual([
      { harness: 'claude-code', version: 2 },
    ]);
    expect((await sessions(h.db.sql)).map((s) => s.parser_version)).toEqual([2, 2]);
  });

  // A file opened during the rebuild is one the current version has not read
  // either, so the rebuild need not wait for it.
  test('switches without waiting for a generation opened while it ran', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: MAIN, path: mainPath() });
    await projectAll(h);
    let opened = false;
    const sql = beforeEachTransaction(h.db.sql, async () => {
      if (!opened) {
        opened = true;
        await upload(h, {
          content: jsonl([user({ at: at(40), session: OTHER })]),
          path: mainPath(OTHER),
        });
      }
    });

    const outcome = await projectTranscripts(sql, { parsers: [nextVersion] });

    expect(outcome.switched).toEqual([{ harness: 'claude-code', version: 2 }]);
    expect(outcome.pending).toBe(1);
  });

  test('deletes the earlier version a bounded batch at a time, its progress last', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);
    await projectAll(h);
    const tables = [
      'projected_requests',
      'projected_tool_calls',
      'projected_subagents',
      'projected_sessions',
      'parse_progress',
    ];
    // How many rows of version 1 each table holds.
    const earlier = async () => {
      const counts: number[] = [];
      for (const table of tables) {
        // oxlint-disable-next-line no-await-in-loop -- one table at a time.
        const [row]: { n: number }[] = await h.db.sql.unsafe(
          `SELECT count(*)::int AS n FROM ${table} WHERE parser_version = 1`,
        );
        counts.push(row?.n ?? 0);
      }
      return counts;
    };
    const total = (counts: number[]) => counts.reduce((sum, n) => sum + n, 0);
    const options = { cleanupRows: 2, parsers: [nextVersion] };
    const before = await earlier();

    const switching = await projectTranscripts(h.db.sql, options);
    const after = [await earlier()];
    for (let run = 0; run < 30 && total(after.at(-1) ?? []) !== 0; run += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one bounded cleanup per run.
      await projectTranscripts(h.db.sql, options);
      // oxlint-disable-next-line no-await-in-loop -- counted after each run.
      after.push(await earlier());
    }

    expect(switching.switched).toEqual([{ harness: 'claude-code', version: 2 }]);
    expect(total(after[0] ?? [])).toBeGreaterThan(0);
    expect(total(after.at(-1) ?? [])).toBe(0);
    // No run deletes more than `cleanupRows` from any table, and progress
    // goes once every fact has.
    const runs = [before, ...after];
    for (const [i, counts] of after.entries()) {
      const previous = runs[i] ?? [];
      for (const [t, n] of counts.entries()) {
        expect((previous[t] ?? 0) - n).toBeLessThanOrEqual(options.cleanupRows);
      }
      if (counts.at(-1) !== previous.at(-1)) {
        expect(total(counts.slice(0, -1))).toBe(0);
      }
    }
  });

  test('a rebuild a restart interrupts resumes, and switches with the same totals', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);
    await projectAll(h);
    const before = await totals(h.db.sql, 'session_totals');
    const stopped = await projectTranscripts(h.db.sql, {
      budgetBytes: 700,
      parsers: [nextVersion],
    });
    expect(stopped.pending).toBeGreaterThan(0);

    const restarted = new SQL(h.db.url.href);
    try {
      await projectAll(
        { ...h, db: { ...h.db, sql: restarted } },
        { budgetBytes: 700, parsers: [nextVersion] },
      );
    } finally {
      await restarted.close();
    }

    expect((await sessions(h.db.sql)).map((s) => s.parser_version)).toEqual([2]);
    expect(await totals(h.db.sql, 'session_totals')).toEqual(before);
  });

  // Another Hub can switch while this one's run is under way.
  test('a Hub that finishes its first set after a newer one switched leaves the newer current', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: MAIN, path: mainPath() });
    let newerRan = false;
    const sql = beforeEachTransaction(h.db.sql, async () => {
      if (!newerRan) {
        newerRan = true;
        await projectAll(h, { parsers: [nextVersion] });
      }
    });

    const older = await projectTranscripts(sql);

    expect(older.switched).toEqual([]);
    expect((await sessions(h.db.sql)).map((s) => s.parser_version)).toEqual([2]);
  });

  test('reports the switch once the rebuild completes', async () => {
    await using h = await startHub();
    await nameSources(h);
    await upload(h, { content: MAIN, path: mainPath() });
    await projectAll(h);

    const outcome = await projectTranscripts(h.db.sql, { parsers: [nextVersion] });

    expect(outcome).toEqual({
      failed: [],
      outdated: [],
      pending: 0,
      switched: [{ harness: 'claude-code', version: 2 }],
    });
  });
});

describe('the insight views', () => {
  test('read no transcript content', async () => {
    await using h = await startHub();

    const used = await h.db.sql`
      SELECT DISTINCT table_name FROM information_schema.view_table_usage
      WHERE view_schema = 'insight' AND table_name = 'transcript_chunks'
    `;

    expect(used).toEqual([]);
  });

  // Rows another parser version wrote, as during a rebuild, stay out of every
  // view, its joins included.
  test("show only the current version's rows", async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);
    await projectAll(h);
    const shown = async () => ({
      calls: [...(await h.db.sql`SELECT * FROM insight.tool_calls ORDER BY call_id`)],
      requests: await requests(h.db.sql),
      sessions: await sessions(h.db.sql),
      subagents: [...(await h.db.sql`SELECT * FROM insight.subagents ORDER BY agent_id`)],
      totals: await totals(h.db.sql, 'session_totals'),
    });
    const before = await shown();

    for (const table of [
      'projected_sessions',
      'projected_subagents',
      'projected_requests',
      'projected_tool_calls',
      'parse_progress',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one table at a time.
      await h.db.sql.unsafe(`
        CREATE TEMPORARY TABLE copied AS SELECT * FROM ${table};
        UPDATE copied SET parser_version = 2;
        INSERT INTO ${table} SELECT * FROM copied;
        DROP TABLE copied;
      `);
    }
    await h.db.sql`UPDATE projected_subagents SET parent_agent_id = NULL WHERE parser_version = 2`;

    expect(await shown()).toEqual(before);
  });

  // Claude Code leaves out the thinking count and the cache split at times.
  test('totals leave null a count no request recorded, and count zero for none', async () => {
    await using h = await startHub();
    await nameSources(h);
    const line = assistant({ at: at(1), id: 'msg_1', usage: { input: 2 } });
    const { cache_creation: _, ...usage } = line.message.usage;
    await upload(h, {
      content: jsonl([user({ at: at(0) }), { ...line, message: { ...line.message, usage } }]),
      path: mainPath(),
    });
    await upload(h, {
      content: jsonl([user({ at: at(0), session: OTHER })]),
      path: mainPath(OTHER),
    });

    await projectAll(h);

    const noCounts = {
      cache_read_tokens: 0,
      cache_write_1h_tokens: null,
      cache_write_5m_tokens: null,
      cache_write_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: null,
    };
    expect(await totals(h.db.sql, 'session_totals')).toEqual([
      { ...noCounts, input_tokens: 2, requests: 1, session_id: SESSION },
      { ...noCounts, input_tokens: 0, requests: 0, session_id: OTHER },
    ]);
  });

  test('show nothing until a parser has built its first complete set', async () => {
    await using h = await startHub();
    await nameSources(h);
    await uploadSession(h);

    await projectTranscripts(h.db.sql, { budgetBytes: 700 });

    expect(await sessions(h.db.sql)).toEqual([]);
  });
});

describe('what serve logs of a run', () => {
  test('each switch and failure, and a Harness left alone only the first time', () => {
    const outdated = new Set<string>();
    const run = {
      failed: [{ error: 'Synthetic failure.', generation: 7, harness: 'claude-code' }],
      outdated: [{ current: 3, harness: 'claude-code', version: 2 }],
      pending: 0,
      switched: [{ harness: 'codex', version: 4 }],
    };

    const first = projectionNotes(run, outdated);
    const second = projectionNotes({ ...run, failed: [], switched: [] }, outdated);

    expect(first).toEqual([
      { level: 'info', text: 'Session insight for codex now reads parser version 4.' },
      {
        level: 'warn',
        text: 'Could not parse generation 7 for claude-code, so it waits for the next parser version: Synthetic failure.',
      },
      {
        level: 'warn',
        text: "Session insight for claude-code is at parser version 3, newer than this Hub's 2, so this Hub leaves it alone until it is upgraded.",
      },
    ]);
    expect(second).toEqual([]);
  });
});
