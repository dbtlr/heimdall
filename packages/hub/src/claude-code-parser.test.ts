import { describe, expect, test } from 'bun:test';

import { classifyClaudeCodePath, parseAgentMeta, parseConversation } from './claude-code-parser.ts';
import {
  agentMeta,
  agentPath,
  assistant,
  costState,
  jsonl,
  mainPath,
  SESSION,
  skillListing,
  user,
} from './testing/claude-code.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

// Parses `text` as a whole generation's content.
const parse = (text: string, { complete = true, offset = 0 } = {}) =>
  parseConversation(bytes(text), { complete, offset });

const T0 = '2026-10-06T12:00:00.000Z';
const T1 = '2026-10-06T12:00:01.000Z';
const T2 = '2026-10-06T12:00:02.000Z';
const T3 = '2026-10-06T12:00:03.000Z';

describe('requests', () => {
  // Claude Code writes one line per content block, each repeating the
  // response's usage, so summing lines overcounts (ADR-0014).
  test('a response streamed over several lines counts once, from its last line', () => {
    const parsed = parse(
      jsonl([
        assistant({
          at: T0,
          block: { kind: 'thinking' },
          id: 'msg_1',
          stop: null,
          usage: { input: 3, output: 1 },
        }),
        assistant({ at: T1, id: 'msg_1', stop: null, usage: { input: 3, output: 1 } }),
        assistant({ at: T2, id: 'msg_1', stop: 'end_turn', usage: { input: 3, output: 40 } }),
      ]),
    );

    expect(parsed.requests).toEqual([
      expect.objectContaining({
        at: Date.parse(T2),
        input: 3,
        output: 40,
        requestId: 'msg_1',
        stopReason: 'end_turn',
      }),
    ]);
  });

  test('carries every kind of token and the line it was read from', () => {
    const first = jsonl([user({ at: T0 })]);
    const parsed = parse(
      first +
        jsonl([
          assistant({
            at: T1,
            id: 'msg_1',
            model: 'claude-opus-5-5',
            usage: {
              cacheRead: 500,
              cacheWrite1h: 7,
              cacheWrite5m: 20,
              input: 3,
              output: 90,
              thinking: 30,
            },
          }),
        ]),
      { offset: 1000 },
    );

    expect(parsed.requests).toEqual([
      {
        at: Date.parse(T1),
        cacheRead: 500,
        cacheWrite: 27,
        cacheWrite1h: 7,
        cacheWrite5m: 20,
        input: 3,
        model: 'claude-opus-5-5',
        offset: 1000 + bytes(first).byteLength,
        output: 90,
        reasoning: 30,
        requestId: 'msg_1',
        skill: null,
        stopReason: 'end_turn',
      },
    ]);
  });

  // An interrupted response never gets a stop reason. Its lines are all
  // partial, and the last of them is the best the transcript has.
  test('an interrupted response counts from its last line', () => {
    const parsed = parse(
      jsonl([
        assistant({ at: T0, id: 'msg_1', stop: null, usage: { input: 3, output: 1 } }),
        assistant({ at: T1, id: 'msg_1', stop: null, usage: { input: 3, output: 12 } }),
      ]),
    );

    expect(parsed.requests).toEqual([
      expect.objectContaining({ output: 12, requestId: 'msg_1', stopReason: null }),
    ]);
  });

  test('a partial line written after the final one does not replace it', () => {
    const parsed = parse(
      jsonl([
        assistant({ at: T0, id: 'msg_1', stop: 'tool_use', usage: { output: 50 } }),
        assistant({ at: T1, id: 'msg_1', stop: null, usage: { output: 2 } }),
      ]),
    );

    expect(parsed.requests).toEqual([
      expect.objectContaining({ output: 50, stopReason: 'tool_use' }),
    ]);
  });

  test('a Session that switches models keeps each request with its own model', () => {
    const parsed = parse(
      jsonl([
        assistant({ at: T0, id: 'msg_1', model: 'claude-sonnet-5-5' }),
        assistant({ at: T1, id: 'msg_2', model: 'claude-opus-5-5' }),
      ]),
    );

    expect(parsed.requests.map((r) => [r.requestId, r.model])).toEqual([
      ['msg_1', 'claude-sonnet-5-5'],
      ['msg_2', 'claude-opus-5-5'],
    ]);
  });

  // Claude Code writes `<synthetic>` messages itself, such as after an
  // interruption; no model answered them.
  test('a synthetic message is not a request', () => {
    const parsed = parse(jsonl([assistant({ at: T0, id: 'msg_1', model: '<synthetic>' })]));

    expect(parsed.requests).toEqual([]);
  });

  test('a skill active for a response is named on its request', () => {
    const parsed = parse(jsonl([assistant({ at: T0, id: 'msg_1', skill: 'tdd' })]));

    expect(parsed.requests).toEqual([expect.objectContaining({ skill: 'tdd' })]);
  });

  test('a response without a thinking count has no reasoning tokens recorded', () => {
    const parsed = parse(jsonl([assistant({ at: T0, id: 'msg_1', usage: { output: 5 } })]));

    expect(parsed.requests).toEqual([expect.objectContaining({ reasoning: null })]);
  });
});

describe('tool calls', () => {
  test('each tool use is one call, linked to the response that made it', () => {
    const parsed = parse(
      jsonl([
        assistant({ at: T0, id: 'msg_1', stop: null }),
        assistant({
          at: T1,
          block: { id: 'toolu_1', kind: 'tool', name: 'Bash' },
          id: 'msg_1',
          stop: null,
        }),
        assistant({
          at: T2,
          block: { id: 'toolu_2', kind: 'tool', name: 'Read' },
          id: 'msg_1',
          stop: 'tool_use',
        }),
      ]),
    );

    expect(parsed.toolCalls).toEqual([
      expect.objectContaining({
        at: Date.parse(T1),
        callId: 'toolu_1',
        kind: 'tool',
        name: 'Bash',
        requestId: 'msg_1',
      }),
      expect.objectContaining({ callId: 'toolu_2', name: 'Read', requestId: 'msg_1' }),
    ]);
  });

  test('an MCP tool names its server', () => {
    const block = {
      id: 'toolu_1',
      kind: 'tool',
      name: 'mcp__plugin_docs_docs__query-docs',
    } as const;
    const parsed = parse(jsonl([assistant({ at: T0, block, id: 'msg_1' })]));

    expect(parsed.toolCalls).toEqual([
      expect.objectContaining({
        mcpServer: 'plugin_docs_docs',
        name: 'mcp__plugin_docs_docs__query-docs',
      }),
    ]);
  });

  test('the Skill tool names the skill it invokes', () => {
    const block = { id: 'toolu_1', input: { skill: 'tdd' }, kind: 'tool', name: 'Skill' } as const;
    const parsed = parse(jsonl([assistant({ at: T0, block, id: 'msg_1' })]));

    expect(parsed.toolCalls).toEqual([
      expect.objectContaining({ mcpServer: null, name: 'Skill', skill: 'tdd' }),
    ]);
  });

  test('a slash command a person typed is a command naming its skill', () => {
    const parsed = parse(jsonl([user({ at: T0, command: '/review', uuid: 'u-1' })]));

    expect(parsed.toolCalls).toEqual([
      {
        at: Date.parse(T0),
        callId: 'u-1',
        kind: 'command',
        mcpServer: null,
        name: '/review',
        offset: 0,
        requestId: null,
        skill: 'review',
      },
    ]);
  });

  test('a listing of the skills available invokes none', () => {
    expect(parse(jsonl([skillListing({ at: T0 })])).toolCalls).toEqual([]);
  });
});

describe('the conversation', () => {
  // Timestamps are not monotonic, so the span is their minimum and maximum.
  test('spans its earliest and latest lines, with the directory, branch, and version at each', () => {
    const parsed = parse(
      jsonl([
        user({ at: T1, branch: 'feature', cwd: '/w/a', version: '2.1.290' }),
        assistant({ at: T0, branch: 'main', cwd: '/w/b', id: 'msg_1', version: '2.1.289' }),
        user({ at: T3, branch: 'release', cwd: '/w/c', version: '2.1.291' }),
        assistant({ at: T2, branch: 'other', cwd: '/w/d', id: 'msg_2', version: '2.1.292' }),
      ]),
    );

    expect(parsed.span).toEqual({
      first: { at: Date.parse(T0), cwd: '/w/b', gitBranch: 'main', version: '2.1.289' },
      last: { at: Date.parse(T3), cwd: '/w/c', gitBranch: 'release', version: '2.1.291' },
    });
  });

  test('lines without a time, such as a cost snapshot, leave the span alone', () => {
    const parsed = parse(jsonl([user({ at: T0 }), costState({ models: {} })]));

    expect(parsed.span?.last.at).toBe(Date.parse(T0));
    expect(parsed.unreadableLines).toBe(0);
  });

  test('a line that is not JSON is counted and skipped', () => {
    const parsed = parse(`{"type":\n${jsonl([user({ at: T0 })])}`);

    expect(parsed.unreadableLines).toBe(1);
    expect(parsed.span?.first.at).toBe(Date.parse(T0));
  });
});

describe('how far it parsed', () => {
  test('through the last newline when the generation may still grow', () => {
    const whole = jsonl([user({ at: T0 })]);

    const parsed = parse(`${whole}{"type":"assist`, { complete: false, offset: 10 });

    expect(parsed.parsedThrough).toBe(10 + bytes(whole).byteLength);
    expect(parsed.unreadableLines).toBe(0);
  });

  test('through a last line without a newline once the content is all held', () => {
    const text = JSON.stringify(user({ at: T0 }));

    const parsed = parse(text);

    expect(parsed.parsedThrough).toBe(bytes(text).byteLength);
    expect(parsed.span?.first.at).toBe(Date.parse(T0));
  });

  // A line longer than a chunk arrives in pieces; its start waits for the rest.
  test('not past the start of a held last line that is not yet whole', () => {
    const whole = jsonl([user({ at: T0 })]);

    const parsed = parse(`${whole}{"type":"assist`, { complete: true });

    expect(parsed.parsedThrough).toBe(bytes(whole).byteLength);
    expect(parsed.unreadableLines).toBe(0);
  });
});

describe('transcript paths', () => {
  test('a main conversation is named by its file', () => {
    expect(classifyClaudeCodePath(mainPath())).toEqual({
      kind: 'conversation',
      owner: { agentId: null, sessionId: SESSION },
    });
  });

  test('a subagent belongs to the Session whose directory holds it', () => {
    expect(classifyClaudeCodePath(agentPath('a1b2'))).toEqual({
      kind: 'conversation',
      owner: { agentId: 'a1b2', sessionId: SESSION },
    });
    expect(classifyClaudeCodePath(agentPath('a1b2', { meta: true }))).toEqual({
      kind: 'agent-meta',
      owner: { agentId: 'a1b2', sessionId: SESSION },
      workflowRun: null,
    });
  });

  test("a workflow agent's run is named by its directory", () => {
    expect(classifyClaudeCodePath(agentPath('a1b2', { meta: true, workflow: 'wf_x1' }))).toEqual({
      kind: 'agent-meta',
      owner: { agentId: 'a1b2', sessionId: SESSION },
      workflowRun: 'wf_x1',
    });
  });

  test.each([
    `projects/p/${SESSION}/subagents/workflows/wf_x1/journal.jsonl`,
    `projects/p/${SESSION}/tool-results/toolu_1.txt`,
    'projects/p/memory/MEMORY.md',
    `projects/p/${SESSION}/workflows/wf_x1.json`,
  ])('%s holds no conversation', (path) => {
    expect(classifyClaudeCodePath(path)).toEqual({ kind: 'other' });
  });
});

describe("a subagent's metadata", () => {
  test('links it to the tool call that spawned it', () => {
    expect(
      parseAgentMeta(agentMeta({ agentType: 'Explore', spawnDepth: 2, toolUseId: 'toolu_9' })),
    ).toEqual({
      agentType: 'Explore',
      depth: 2,
      parentAgentId: null,
      toolUseId: 'toolu_9',
      workflowPhase: null,
    });
  });

  test("names a workflow agent's phase", () => {
    expect(
      parseAgentMeta(agentMeta({ agentType: 'workflow-subagent', workflowPhase: 'Implement' })),
    ).toEqual(expect.objectContaining({ toolUseId: null, workflowPhase: 'Implement' }));
  });

  test('that is not JSON is unreadable', () => {
    expect(parseAgentMeta('{"agentType":')).toBeUndefined();
  });
});
