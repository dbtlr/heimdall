import { describe, expect, test } from 'bun:test';

import {
  classifyClaudeCodePath,
  claudeCodeParser,
  parseAgentMeta,
  parseConversation,
} from './claude-code-parser.ts';
import { MAX_ID_LENGTH } from './session-insight.ts';
import {
  agentMeta,
  agentPath,
  assistant,
  commandLine,
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

  // A built-in command such as `/doctor` is no skill; skills come from the
  // Skill tool and the skill a request is attributed to.
  test('a slash command a person typed is a command, naming no skill', () => {
    const parsed = parse(jsonl([user({ at: T0, command: '/review', uuid: 'u-1' })]));

    expect(parsed.toolCalls).toEqual([
      {
        at: Date.parse(T0),
        callId: 'u-1',
        kind: 'command',
        lineId: 'u-1',
        mcpServer: null,
        name: '/review',
        offset: 0,
        requestId: null,
        skill: null,
      },
    ]);
  });

  test('each command a line carries is a call of its own', () => {
    const line = {
      ...user({ at: T0, uuid: 'u-1' }),
      message: {
        content: '<command-name>/clear</command-name> <command-name>/plugin:run</command-name>',
        role: 'user',
      },
    };

    expect(parse(jsonl([line])).toolCalls.map((c) => [c.callId, c.name])).toEqual([
      ['u-1', '/clear'],
      ['u-1#1', '/plugin:run'],
    ]);
  });

  // A prompt can quote the tag around anything, a secret included, and the
  // views carry no content.
  test.each([
    ['prose', 'my bank PIN is 4321'],
    ['too long', `/${'x'.repeat(65)}`],
    ['empty', ''],
  ])('a command name that is %s is dropped and the line counted', (_, name) => {
    const line = {
      ...user({ at: T0, uuid: 'u-1' }),
      message: { content: `please read <command-name>${name}</command-name>`, role: 'user' },
    };

    const parsed = parse(jsonl([line]));

    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.unreadableLines).toBe(1);
    expect(parsed.span?.first.at).toBe(Date.parse(T0));
  });

  // The database keeps the first line of a call it holds, so a batch does too,
  // and parsing in pieces derives what parsing whole does.
  test('a command line written twice under one uuid keeps its first line', () => {
    const parsed = parse(
      jsonl([
        user({ at: T0, command: '/review', uuid: 'u-1' }),
        user({ at: T1, command: '/review', uuid: 'u-1' }),
      ]),
    );

    expect(parsed.toolCalls).toEqual([expect.objectContaining({ at: Date.parse(T0), offset: 0 })]);
  });

  // The first line with a command under a uuid owns every command of that
  // uuid, however many a later line carries.
  test('a later line under the same uuid adds no command, whatever it carries', () => {
    const parsed = parse(
      jsonl([
        commandLine({ at: T0, commands: ['/a'], uuid: 'dup' }),
        commandLine({ at: T1, commands: ['/b', '/c'], uuid: 'dup' }),
      ]),
    );

    expect(parsed.toolCalls.map((c) => [c.callId, c.name])).toEqual([['dup', '/a']]);
  });

  test('a command id derived from a uuid at the bound stays within it', () => {
    const uuid = 'u'.repeat(MAX_ID_LENGTH);
    const line = commandLine({ at: T0, commands: ['/a', '/b'], uuid });

    const ids = parse(jsonl([line])).toolCalls.map((c) => c.callId);

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(uuid);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length <= MAX_ID_LENGTH)).toBe(true);
  });

  test('a listing of the skills available invokes none', () => {
    expect(parse(jsonl([skillListing({ at: T0 })])).toolCalls).toEqual([]);
  });
});

// The views carry no content, so a field that names or identifies something
// holds only a value shaped like a name, an id, or a version. Prose a line
// carries there is left out: a value the fact needs leaves the fact out and
// counts the line, and any other becomes null.
describe('names, ids, and versions', () => {
  const PROSE = 'my bank PIN is 4321';

  test.each([
    ['its model', assistant({ at: T0, id: 'msg_1', model: PROSE })],
    ['its id', assistant({ at: T0, id: PROSE })],
  ])('a response with prose for %s is left out, and the line counted', (_, line) => {
    const parsed = parse(jsonl([line]));

    expect(parsed).toEqual(
      expect.objectContaining({ requests: [], toolCalls: [], unreadableLines: 1 }),
    );
    expect(parsed.span?.first.at).toBe(Date.parse(T0));
  });

  test.each([
    ['its name', { id: 'toolu_1', kind: 'tool', name: PROSE } as const],
    ['its MCP server', { id: 'toolu_1', kind: 'tool', name: `mcp__${PROSE}__query` } as const],
    ['its id', { id: PROSE, kind: 'tool', name: 'Read' } as const],
  ])('a tool call with prose for %s is left out, and the line counted', (_, block) => {
    const parsed = parse(jsonl([assistant({ at: T0, block, id: 'msg_1' })]));

    expect(parsed.requests).toEqual([expect.objectContaining({ requestId: 'msg_1' })]);
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.unreadableLines).toBe(1);
  });

  test('a command line with prose for its uuid is left out, and the line counted', () => {
    const parsed = parse(jsonl([user({ at: T0, command: '/review', uuid: PROSE })]));

    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.unreadableLines).toBe(1);
  });

  test.each([
    ['stop reason', assistant({ at: T0, id: 'msg_1', stop: PROSE }), { stopReason: null }],
    ['skill attribution', assistant({ at: T0, id: 'msg_1', skill: PROSE }), { skill: null }],
  ])('a response with prose for its %s keeps it null', (_, line, fields) => {
    const parsed = parse(jsonl([line]));

    expect(parsed.requests).toEqual([expect.objectContaining({ requestId: 'msg_1', ...fields })]);
    expect(parsed.unreadableLines).toBe(0);
  });

  test('a Skill call with prose for its skill names none', () => {
    const block = { id: 'toolu_1', input: { skill: PROSE }, kind: 'tool', name: 'Skill' } as const;

    const parsed = parse(jsonl([assistant({ at: T0, block, id: 'msg_1' })]));

    expect(parsed.toolCalls).toEqual([expect.objectContaining({ name: 'Skill', skill: null })]);
    expect(parsed.unreadableLines).toBe(0);
  });

  test('a line with prose for its Harness version keeps it null', () => {
    const parsed = parse(jsonl([user({ at: T0, version: PROSE })]));

    expect(parsed.span?.first).toEqual(expect.objectContaining({ version: null }));
    expect(parsed.unreadableLines).toBe(0);
  });

  test('a working directory and a branch are kept as written', () => {
    const parsed = parse(jsonl([user({ at: T0, branch: 'fix: the PIN', cwd: '/w/my PIN' })]));

    expect(parsed.span?.first).toEqual(
      expect.objectContaining({ cwd: '/w/my PIN', gitBranch: 'fix: the PIN' }),
    );
  });

  test("a subagent's metadata with prose for a name or an id keeps it null", () => {
    const meta = JSON.stringify({
      agentType: PROSE,
      parentAgentId: PROSE,
      spawnDepth: 2,
      toolUseId: PROSE,
      workflowPhase: PROSE,
    });

    expect(parseAgentMeta(meta)).toEqual({
      agentType: null,
      depth: 2,
      parentAgentId: null,
      toolUseId: null,
      workflowPhase: null,
    });
  });

  test('names, ids, and versions as Claude Code writes them are kept', () => {
    const meta = JSON.stringify({
      agentType: 'plugin-dev:agent-creator',
      parentAgentId: 'a1b2c3d4e5f6',
      toolUseId: 'toolu_01AbC',
      workflowPhase: 'Implement',
    });
    const parsed = parse(
      jsonl([
        assistant({
          at: T0,
          block: { id: 'toolu_01AbC', kind: 'tool', name: 'mcp__plugin_x_y__query-docs' },
          id: 'msg_01XyZ',
          model: 'claude-opus-4-1@20250805',
          stop: 'tool_use',
          version: '2.1.290-beta.1',
        }),
      ]),
    );

    expect(parseAgentMeta(meta)).toEqual(
      expect.objectContaining({
        agentType: 'plugin-dev:agent-creator',
        parentAgentId: 'a1b2c3d4e5f6',
      }),
    );
    expect(parsed.requests).toEqual([
      expect.objectContaining({ model: 'claude-opus-4-1@20250805', stopReason: 'tool_use' }),
    ]);
    expect(parsed.toolCalls).toEqual([expect.objectContaining({ mcpServer: 'plugin_x_y' })]);
    expect(parsed.span?.first.version).toBe('2.1.290-beta.1');
    expect(parsed.unreadableLines).toBe(0);
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

  // In file order, a later line at the same moment is the later one.
  test('ends at the later of two lines written at the same moment', () => {
    const parsed = parse(
      jsonl([
        user({ at: T0, cwd: '/w/a' }),
        user({ at: T1, cwd: '/w/b' }),
        user({ at: T1, cwd: '/w/c' }),
      ]),
    );

    expect(parsed.span?.last.cwd).toBe('/w/c');
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

const tool = (id: string) => ({ id, kind: 'tool', name: 'Read' }) as const;

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

  // A batch holds a bounded number of facts, and a line is never split.
  test('through the line at which it holds as many facts as asked, and no further', () => {
    const lines = [
      assistant({ at: T0, block: tool('toolu_1'), id: 'msg_1' }),
      { ...user({ at: T1 }), cwd: '\0'.repeat(5000) },
      assistant({ at: T2, block: tool('toolu_2'), id: 'msg_2' }),
      '{"type":',
      assistant({ at: T3, block: tool('toolu_3'), id: 'msg_3' }),
    ];
    const text = lines
      .map((line) => (typeof line === 'string' ? `${line}\n` : jsonl([line])))
      .join('');
    const through = bytes(text.split('\n').slice(0, 3).join('\n')).byteLength + 1;

    const parsed = parseConversation(bytes(text), { complete: true, factLimit: 3, offset: 0 });

    expect(parsed).toEqual(
      expect.objectContaining({ atFactLimit: true, parsedThrough: through, unreadableLines: 1 }),
    );
    expect(parsed.requests.map((r) => r.requestId)).toEqual(['msg_1', 'msg_2']);
    expect(parsed.toolCalls.map((c) => c.callId)).toEqual(['toolu_1', 'toolu_2']);
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

  test('is unreadable with a value out of bounds', () => {
    expect(parseAgentMeta(agentMeta({ agentType: 'Explore', toolUseId: 't'.repeat(256) }))).toBe(
      undefined,
    );
    expect(
      parseAgentMeta(agentMeta({ agentType: 'Explore', spawnDepth: 2 ** 31, toolUseId: 't1' })),
    ).toBe(undefined);
  });
});

describe('the parser as the projection runs it', () => {
  const meta = agentMeta({ agentType: 'Explore', toolUseId: 'toolu_9' });

  // Content that stops short of what the Hub holds may be cut off anywhere.
  test("reads a subagent's metadata only once the Hub's whole content is read", () => {
    const parsed = claudeCodeParser.parse({
      complete: false,
      content: bytes(`${meta}  `),
      factLimit: Number.POSITIVE_INFINITY,
      offset: 0,
      path: agentPath('a1', { meta: true }),
    });

    expect(parsed).toEqual(expect.objectContaining({ agent: null, parsedThrough: 0 }));
  });

  test('counts metadata it cannot read as one unreadable line', () => {
    const parsed = claudeCodeParser.parse({
      complete: true,
      content: bytes('{"agentType":'),
      factLimit: Number.POSITIVE_INFINITY,
      offset: 0,
      path: agentPath('a1', { meta: true }),
    });

    expect(parsed).toEqual(expect.objectContaining({ agent: null, unreadableLines: 1 }));
  });
});

// A line holds whatever its Harness wrote, so the parser keeps only what
// PostgreSQL can store and what a transcript plausibly holds. A line it
// rejects is counted, never stored in part.
describe('a line the database could not store', () => {
  test('keeps its text with NUL replaced', () => {
    const parsed = parse(jsonl([{ ...user({ at: T0 }), cwd: '/w/a\0b', gitBranch: 'x\0' }]));

    expect(parsed.span?.first).toEqual(expect.objectContaining({ cwd: '/w/a�b', gitBranch: 'x�' }));
    expect(parsed.unreadableLines).toBe(0);
  });

  test.each([
    ['before the year 1', '-005000-01-01T00:00:00.000Z'],
    ['after the year 9999', '+010000-01-01T00:00:00.000Z'],
    ['that does not parse', 'yesterday'],
  ])('with a time %s is unreadable', (_, timestamp) => {
    const parsed = parse(jsonl([{ ...assistant({ at: T0, id: 'msg_1' }), timestamp }]));

    expect(parsed).toEqual(
      expect.objectContaining({ requests: [], span: null, toolCalls: [], unreadableLines: 1 }),
    );
  });

  test('a response without a time is unreadable', () => {
    const { timestamp: _, ...line } = assistant({ at: T0, id: 'msg_1' });

    expect(parse(jsonl([line]))).toEqual(
      expect.objectContaining({ requests: [], unreadableLines: 1 }),
    );
  });

  test.each([
    ['a response id', { ...assistant({ at: T0, id: 'm'.repeat(256) }) }],
    [
      'a tool call id',
      assistant({
        at: T0,
        block: { id: 't'.repeat(256), kind: 'tool', name: 'Read' },
        id: 'msg_1',
      }),
    ],
    ['a working directory', assistant({ at: T0, cwd: `/${'d'.repeat(4096)}`, id: 'msg_1' })],
    ['a model', assistant({ at: T0, id: 'msg_1', model: 'm'.repeat(256) })],
  ])('with %s longer than the bound is unreadable', (_, line) => {
    expect(parse(jsonl([line]))).toEqual(
      expect.objectContaining({ requests: [], span: null, toolCalls: [], unreadableLines: 1 }),
    );
  });

  test.each([
    ['negative', -1],
    ['above the bound', 1_000_000_001],
    ['not an integer', 1.5],
    ['not a number', '5'],
  ])('with a token count %s is unreadable', (_, input) => {
    const line = assistant({ at: T0, id: 'msg_1' });
    line.message.usage = { ...line.message.usage, input_tokens: input as number };

    expect(parse(jsonl([line]))).toEqual(
      expect.objectContaining({ requests: [], unreadableLines: 1 }),
    );
  });

  test('a token count at the bound is read', () => {
    const parsed = parse(jsonl([assistant({ at: T0, id: 'msg_1', usage: { input: 1e9 } })]));

    expect(parsed.requests).toEqual([expect.objectContaining({ input: 1e9 })]);
  });
});
