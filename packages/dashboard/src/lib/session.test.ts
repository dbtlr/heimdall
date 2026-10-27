import { describe, expect, test } from 'bun:test';

import type {
  SessionAgent,
  SessionRequest,
  SessionStretch,
  SessionToolCall,
  SessionView,
} from '../server/session-view-types.ts';
import {
  PAUSE_MS,
  agentLanes,
  commandMarks,
  concurrentAt,
  contextFill,
  costBy,
  costByKind,
  density,
  descendantLanes,
  filterTrace,
  runningCost,
  stretchAt,
  toolCounts,
  traceEntries,
} from './session.ts';
import type { AgentLane, TraceEntry } from './session.ts';

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 13, 16, 0, 0);
// The time `minutes` after the Session started.
const at = (minutes: number): number => T0 + minutes * MINUTE;

let sequence = 0;

// A main-conversation request, priced at nothing, with fields overridden.
const request = (overrides: Partial<SessionRequest> = {}): SessionRequest => {
  sequence += 1;
  return {
    agentId: undefined,
    at: T0,
    cacheReadCostUsd: 0,
    cacheReadTokens: 0,
    cacheWriteCostUsd: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    contextWindow: undefined,
    costUsd: 0,
    inputCostUsd: 0,
    inputTokens: 0,
    interrupted: false,
    model: 'opus',
    outputCostUsd: 0,
    outputTokens: 0,
    requestId: `r${sequence}`,
    skill: undefined,
    stopReason: 'tool_use',
    ...overrides,
  };
};

// A request that ran at minute `minutes`.
const requestAt = (minutes: number, overrides: Partial<SessionRequest> = {}): SessionRequest =>
  request({ at: at(minutes), ...overrides });

const agent = (agentId: string, overrides: Partial<SessionAgent> = {}): SessionAgent => ({
  agentId,
  agentType: undefined,
  depth: 1,
  endedAt: at(60),
  parentAgentId: undefined,
  startedAt: at(0),
  workflowPhase: undefined,
  workflowRun: undefined,
  ...overrides,
});

const call = (overrides: Partial<SessionToolCall> = {}): SessionToolCall => {
  sequence += 1;
  return {
    agentId: undefined,
    at: T0,
    callId: `c${sequence}`,
    kind: 'tool',
    mcpServer: undefined,
    name: 'Bash',
    requestId: undefined,
    ...overrides,
  };
};

const stretch = (overrides: Partial<SessionStretch> = {}): SessionStretch => ({
  candidates: 1,
  endedAt: at(10),
  link: 'linked',
  pid: 100,
  processId: 1,
  requests: 1,
  startedAt: at(0),
  ...overrides,
});

const view = (overrides: Partial<SessionView> = {}): SessionView => ({
  agents: [],
  branch: undefined,
  bucketMs: MINUTE,
  cpu: [],
  cwd: undefined,
  endedAt: at(60),
  harness: 'claude-code',
  harnessVersion: undefined,
  processes: [],
  project: undefined,
  requests: [],
  sessionId: 's1',
  source: 'local',
  startedAt: T0,
  stretches: [],
  system: 'box',
  toolCalls: [],
  totals: {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    mainRequests: 0,
    outputTokens: 0,
    pricedCostUsd: 0,
    requests: 0,
    unpricedRequests: 0,
  },
  ...overrides,
});

const lane = (overrides: Partial<AgentLane> = {}): AgentLane => ({
  agentId: undefined,
  agentType: undefined,
  costUsd: 0,
  depth: 0,
  endedAt: at(60),
  label: 'Main conversation',
  model: undefined,
  phase: undefined,
  requests: [],
  startedAt: T0,
  tokens: 0,
  toolCalls: 0,
  workflowRun: undefined,
  ...overrides,
});

const agentIds = (lanes: readonly AgentLane[]) => lanes.map((entry) => entry.agentId);
const entryKinds = (entries: readonly TraceEntry[]) => entries.map((entry) => entry.kind);
const entriesOf = (source: SessionView) => traceEntries(source, agentLanes(source));

describe('agentLanes', () => {
  test('the main conversation comes first, spanning its first to last request', () => {
    const lanes = agentLanes(view({ requests: [requestAt(2), requestAt(5), requestAt(9)] }));
    expect(lanes[0]).toMatchObject({
      agentId: undefined,
      agentType: undefined,
      depth: 0,
      endedAt: at(9),
      label: 'Main conversation',
      phase: undefined,
      startedAt: at(2),
      workflowRun: undefined,
    });
  });

  test('a main conversation with no requests spans the Session', () => {
    const [main] = agentLanes(view({ endedAt: at(30), startedAt: at(4) }));
    expect(main).toMatchObject({ costUsd: 0, endedAt: at(30), model: undefined, startedAt: at(4) });
  });

  test('a subagent is labeled by its type, or "Subagent" without one', () => {
    const lanes = agentLanes(
      view({ agents: [agent('a', { agentType: 'Explore' }), agent('b', { startedAt: at(1) })] }),
    );
    expect(lanes.map((entry) => entry.label)).toEqual(['Main conversation', 'Explore', 'Subagent']);
  });

  test('a subagent carries its span, type, phase, and workflow run', () => {
    const lanes = agentLanes(
      view({
        agents: [
          agent('a', {
            agentType: 'worker',
            endedAt: at(20),
            startedAt: at(12),
            workflowPhase: 'build',
            workflowRun: 'run-1',
          }),
        ],
      }),
    );
    expect(lanes[1]).toMatchObject({
      agentId: 'a',
      agentType: 'worker',
      endedAt: at(20),
      phase: 'build',
      startedAt: at(12),
      workflowRun: 'run-1',
    });
  });

  test('a subagent with no parent is at depth 1, one with a parent is one deeper', () => {
    const lanes = agentLanes(
      view({
        agents: [
          agent('a'),
          agent('b', { parentAgentId: 'a', startedAt: at(1) }),
          agent('c', { parentAgentId: 'b', startedAt: at(2) }),
        ],
      }),
    );
    expect(lanes.map((entry) => entry.depth)).toEqual([0, 1, 2, 3]);
  });

  test('depth ignores the depth field, which is the Harness spawn depth', () => {
    const lanes = agentLanes(view({ agents: [agent('a', { depth: 4 })] }));
    expect(lanes[1]?.depth).toBe(1);
  });

  test('a subagent whose parent is unknown is top level', () => {
    const lanes = agentLanes(view({ agents: [agent('a', { parentAgentId: 'gone' })] }));
    expect(lanes[1]).toMatchObject({ agentId: 'a', depth: 1 });
  });

  test('children follow their parent, each level in start order', () => {
    const lanes = agentLanes(
      view({
        agents: [
          agent('late', { startedAt: at(30) }),
          agent('child-b', { parentAgentId: 'first', startedAt: at(15) }),
          agent('first', { startedAt: at(10) }),
          agent('child-a', { parentAgentId: 'first', startedAt: at(12) }),
        ],
      }),
    );
    expect(agentIds(lanes)).toEqual([undefined, 'first', 'child-a', 'child-b', 'late']);
  });

  test('workflow agents come after the rest, grouped by run in order of first start', () => {
    const lanes = agentLanes(
      view({
        agents: [
          agent('w2-first', { startedAt: at(5), workflowRun: 'run-2' }),
          agent('w1-late', { startedAt: at(40), workflowRun: 'run-1' }),
          agent('plain', { startedAt: at(50) }),
          agent('w1-first', { startedAt: at(20), workflowRun: 'run-1' }),
          agent('w2-late', { startedAt: at(45), workflowRun: 'run-2' }),
        ],
      }),
    );
    expect(agentIds(lanes)).toEqual([
      undefined,
      'plain',
      'w2-first',
      'w2-late',
      'w1-first',
      'w1-late',
    ]);
  });

  test('within a workflow run agents nest under their parent', () => {
    const lanes = agentLanes(
      view({
        agents: [
          agent('root', { startedAt: at(5), workflowRun: 'run-1' }),
          agent('other', { startedAt: at(8), workflowRun: 'run-1' }),
          agent('kid', { parentAgentId: 'root', startedAt: at(20), workflowRun: 'run-1' }),
        ],
      }),
    );
    expect(agentIds(lanes)).toEqual([undefined, 'root', 'kid', 'other']);
    expect(lanes.map((entry) => entry.depth)).toEqual([0, 1, 2, 1]);
  });

  test('every lane in a workflow run’s group carries the run, even a child without it', () => {
    const lanes = agentLanes(
      view({
        agents: [
          agent('root', { startedAt: at(5), workflowRun: 'run-1' }),
          agent('kid', { parentAgentId: 'root', startedAt: at(6) }),
          agent('grandkid', { parentAgentId: 'kid', startedAt: at(7) }),
          agent('plain', { startedAt: at(1) }),
        ],
      }),
    );
    expect(lanes.map((entry) => [entry.agentId, entry.workflowRun])).toEqual([
      [undefined, undefined],
      ['plain', undefined],
      ['root', 'run-1'],
      ['kid', 'run-1'],
      ['grandkid', 'run-1'],
    ]);
  });

  test('toolCalls counts that agent’s tool calls, not commands or other agents’', () => {
    const lanes = agentLanes(
      view({
        agents: [agent('a')],
        toolCalls: [
          call({ agentId: 'a' }),
          call({ agentId: 'a' }),
          call({ agentId: 'a', kind: 'command', name: '/clear' }),
          call({ agentId: undefined }),
        ],
      }),
    );
    expect(lanes.map((entry) => entry.toolCalls)).toEqual([1, 2]);
  });

  test('tokens are input plus output over the lane’s requests', () => {
    const [main] = agentLanes(
      view({
        requests: [
          requestAt(0, { cacheReadTokens: 999, inputTokens: 10, outputTokens: 5 }),
          requestAt(1, { inputTokens: 1, outputTokens: 2 }),
        ],
      }),
    );
    expect(main?.tokens).toBe(18);
  });

  test('a lane holds only its own requests, in time order', () => {
    const late = requestAt(9, { agentId: 'a' });
    const early = requestAt(3, { agentId: 'a' });
    const main = requestAt(5);
    const lanes = agentLanes(view({ agents: [agent('a')], requests: [late, main, early] }));
    expect(lanes[0]?.requests).toEqual([main]);
    expect(lanes[1]?.requests).toEqual([early, late]);
  });

  test('the model is the one that answered most requests', () => {
    const [main] = agentLanes(
      view({
        requests: [
          requestAt(0, { model: 'sonnet' }),
          requestAt(1, { model: 'opus' }),
          requestAt(2, { model: 'opus' }),
        ],
      }),
    );
    expect(main?.model).toBe('opus');
  });

  test('a tie between models goes to the one seen first', () => {
    const [main] = agentLanes(
      view({
        requests: [
          requestAt(0, { model: 'sonnet' }),
          requestAt(1, { model: 'opus' }),
          requestAt(2, { model: 'opus' }),
          requestAt(3, { model: 'sonnet' }),
        ],
      }),
    );
    expect(main?.model).toBe('sonnet');
  });

  test('cost is the sum of the lane’s requests', () => {
    const [main] = agentLanes(
      view({ requests: [requestAt(0, { costUsd: 0.25 }), requestAt(1, { costUsd: 0.5 })] }),
    );
    expect(main?.costUsd).toBeCloseTo(0.75);
  });

  test('one unpriced request leaves the lane’s cost undefined', () => {
    const [main] = agentLanes(
      view({ requests: [requestAt(0, { costUsd: 0.25 }), requestAt(1, { costUsd: undefined })] }),
    );
    expect(main?.costUsd).toBeUndefined();
  });

  test('a subagent with no requests costs nothing and has no model', () => {
    const lanes = agentLanes(view({ agents: [agent('a')] }));
    expect(lanes[1]).toMatchObject({ costUsd: 0, model: undefined, requests: [], tokens: 0 });
  });
});

describe('descendantLanes', () => {
  const lanes = agentLanes(
    view({
      agents: [
        agent('a', { startedAt: at(1) }),
        agent('b', { parentAgentId: 'a', startedAt: at(2) }),
        agent('c', { parentAgentId: 'b', startedAt: at(3) }),
        agent('d', { startedAt: at(4) }),
      ],
    }),
  );
  const laneOf = (agentId: string | undefined) => {
    const found = lanes.find((entry) => entry.agentId === agentId);
    if (found === undefined) {
      throw new Error(`no lane ${agentId}`);
    }
    return found;
  };

  test('is the deeper lanes right after the lane, up to the next that is not deeper', () => {
    expect(agentIds(descendantLanes(lanes, laneOf('a')))).toEqual(['b', 'c']);
    expect(agentIds(descendantLanes(lanes, laneOf('b')))).toEqual(['c']);
  });

  test('is empty for a lane with nothing under it, even with lanes after it', () => {
    expect(descendantLanes(lanes, laneOf('c'))).toEqual([]);
    expect(descendantLanes(lanes, laneOf('d'))).toEqual([]);
  });

  test('the main conversation holds every subagent', () => {
    expect(agentIds(descendantLanes(lanes, laneOf(undefined)))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('costByKind', () => {
  test('sums each kind’s cost and tokens, costliest first', () => {
    const kinds = costByKind([
      request({
        cacheReadCostUsd: 0.5,
        cacheReadTokens: 500,
        costUsd: 0.9,
        inputCostUsd: 0.1,
        inputTokens: 10,
        outputCostUsd: 0.3,
        outputTokens: 30,
      }),
      request({
        cacheReadCostUsd: 0.25,
        cacheReadTokens: 250,
        costUsd: 0.25,
        inputTokens: 0,
        outputTokens: 0,
      }),
    ]);
    expect(kinds).toEqual([
      { costUsd: 0.75, kind: 'cacheRead', tokens: 750 },
      { costUsd: 0.3, kind: 'output', tokens: 30 },
      { costUsd: 0.1, kind: 'input', tokens: 10 },
      { costUsd: 0, kind: 'cacheWrite', tokens: 0 },
    ]);
  });

  test('an unpriced request adds neither cost nor tokens', () => {
    const kinds = costByKind([
      request({ costUsd: 0.1, inputCostUsd: 0.1, inputTokens: 10 }),
      request({
        costUsd: undefined,
        inputCostUsd: undefined,
        inputTokens: 99,
        outputCostUsd: undefined,
        outputTokens: 99,
      }),
    ]);
    expect(kinds.find((entry) => entry.kind === 'input')).toEqual({
      costUsd: 0.1,
      kind: 'input',
      tokens: 10,
    });
    expect(kinds.find((entry) => entry.kind === 'output')?.tokens).toBe(0);
  });

  test('all four kinds are present even with no requests', () => {
    const kinds = costByKind([]);
    expect(kinds.map((entry) => entry.kind).toSorted()).toEqual([
      'cacheRead',
      'cacheWrite',
      'input',
      'output',
    ]);
    expect(kinds.every((entry) => entry.costUsd === 0 && entry.tokens === 0)).toBe(true);
  });
});

describe('runningCost', () => {
  test('one cumulative point per request, split between main and subagents', () => {
    const points = runningCost([
      requestAt(0, { costUsd: 1 }),
      requestAt(1, { agentId: 'a', costUsd: 2 }),
      requestAt(2, { costUsd: 4 }),
    ]);
    expect(points).toEqual([
      { main: 1, subagents: 0, t: at(0) },
      { main: 1, subagents: 2, t: at(1) },
      { main: 5, subagents: 2, t: at(2) },
    ]);
  });

  test('an unpriced request adds nothing but still has a point', () => {
    const points = runningCost([
      requestAt(0, { costUsd: 1 }),
      requestAt(1, { costUsd: undefined }),
    ]);
    expect(points.map((point) => point.main)).toEqual([1, 1]);
  });

  test('points follow time, not input order', () => {
    const points = runningCost([requestAt(5, { costUsd: 2 }), requestAt(1, { costUsd: 1 })]);
    expect(points).toEqual([
      { main: 1, subagents: 0, t: at(1) },
      { main: 3, subagents: 0, t: at(5) },
    ]);
  });
});

describe('contextFill', () => {
  test('lists the main conversation’s context, leaving subagents out', () => {
    const points = contextFill([
      requestAt(0, { contextTokens: 100, contextWindow: 200_000 }),
      requestAt(1, { agentId: 'a', contextTokens: 999 }),
      requestAt(2, { contextTokens: 300, contextWindow: undefined }),
    ]);
    expect(points).toEqual([
      { t: at(0), tokens: 100, window: 200_000 },
      { t: at(2), tokens: 300, window: undefined },
    ]);
  });
});

describe('commandMarks', () => {
  const requests = [
    requestAt(0, { contextTokens: 100 }),
    requestAt(10, { contextTokens: 900 }),
    requestAt(20, { contextTokens: 50 }),
  ];

  test('a command after which the context shrank carries both sides', () => {
    const marks = commandMarks(requests, [call({ at: at(15), kind: 'command', name: 'compact' })]);
    expect(marks).toEqual([{ after: 50, at: at(15), before: 900, name: 'compact' }]);
  });

  test('a compact after which the context grew has neither side', () => {
    const marks = commandMarks(requests, [call({ at: at(5), kind: 'command', name: 'compact' })]);
    expect(marks).toEqual([{ after: undefined, at: at(5), before: undefined, name: 'compact' }]);
  });

  test('only compact can carry sides: a rewind that shrank the context has none', () => {
    const marks = commandMarks(requests, [call({ at: at(15), kind: 'command', name: 'rewind' })]);
    expect(marks).toEqual([{ after: undefined, at: at(15), before: undefined, name: 'rewind' }]);
  });

  test('a request at the same moment counts as before the command', () => {
    const marks = commandMarks(requests, [call({ at: at(10), kind: 'command', name: 'compact' })]);
    expect(marks[0]).toMatchObject({ after: 50, before: 900 });
  });

  test('a command with no request after it has neither side', () => {
    const marks = commandMarks(requests, [call({ at: at(30), kind: 'command', name: 'compact' })]);
    expect(marks[0]).toMatchObject({ after: undefined, before: undefined });
  });

  test('a command before any request has neither side', () => {
    const marks = commandMarks(requests, [call({ at: at(-5), kind: 'command', name: 'compact' })]);
    expect(marks[0]).toMatchObject({ after: undefined, before: undefined });
  });

  test('tool calls and subagent commands are not marks', () => {
    const marks = commandMarks(requests, [
      call({ at: at(5), kind: 'tool', name: 'Bash' }),
      call({ agentId: 'a', at: at(5), kind: 'command', name: 'compact' }),
    ]);
    expect(marks).toEqual([]);
  });

  test('subagent requests do not count as a side', () => {
    const marks = commandMarks(
      [
        requestAt(0, { contextTokens: 500 }),
        requestAt(5, { agentId: 'a', contextTokens: 1 }),
        requestAt(10, { contextTokens: 400 }),
      ],
      [call({ at: at(7), kind: 'command', name: 'compact' })],
    );
    expect(marks[0]).toMatchObject({ after: 400, before: 500 });
  });
});

describe('costBy', () => {
  test('groups by model, summing cost and counting requests, costliest first', () => {
    const shares = costBy(
      [
        request({ costUsd: 1, model: 'sonnet' }),
        request({ costUsd: 2, model: 'opus' }),
        request({ costUsd: 3, model: 'sonnet' }),
      ],
      'model',
    );
    expect(shares).toEqual([
      { costUsd: 4, key: 'sonnet', requests: 2 },
      { costUsd: 2, key: 'opus', requests: 1 },
    ]);
  });

  test('groups by skill, with requests outside any skill under an undefined key', () => {
    const shares = costBy(
      [
        request({ costUsd: 1, skill: undefined }),
        request({ costUsd: 5, skill: 'review' }),
        request({ costUsd: 1, skill: undefined }),
      ],
      'skill',
    );
    expect(shares).toEqual([
      { costUsd: 5, key: 'review', requests: 1 },
      { costUsd: 2, key: undefined, requests: 2 },
    ]);
  });

  test('a group with an unpriced request has no cost and sorts after priced ones', () => {
    const shares = costBy(
      [
        request({ costUsd: undefined, model: 'mystery' }),
        request({ costUsd: undefined, model: 'mystery' }),
        request({ costUsd: 0.5, model: 'opus' }),
        request({ costUsd: undefined, model: 'other' }),
        request({ costUsd: 1, model: 'mystery' }),
      ],
      'model',
    );
    expect(shares).toEqual([
      { costUsd: 0.5, key: 'opus', requests: 1 },
      { costUsd: undefined, key: 'mystery', requests: 3 },
      { costUsd: undefined, key: 'other', requests: 1 },
    ]);
  });
});

describe('toolCounts', () => {
  test('counts calls per tool, most first', () => {
    const counts = toolCounts([
      call({ name: 'Read' }),
      call({ name: 'Bash' }),
      call({ name: 'Bash' }),
    ]);
    expect(counts).toEqual([
      { calls: 2, mcpServer: undefined, name: 'Bash' },
      { calls: 1, mcpServer: undefined, name: 'Read' },
    ]);
  });

  test('the same name on different MCP servers counts separately', () => {
    const counts = toolCounts([
      call({ mcpServer: 'alpha', name: 'search' }),
      call({ mcpServer: 'beta', name: 'search' }),
      call({ mcpServer: 'beta', name: 'search' }),
      call({ name: 'search' }),
    ]);
    expect(counts).toEqual([
      { calls: 2, mcpServer: 'beta', name: 'search' },
      { calls: 1, mcpServer: 'alpha', name: 'search' },
      { calls: 1, mcpServer: undefined, name: 'search' },
    ]);
  });

  test('slash commands are not tool calls', () => {
    expect(toolCounts([call({ kind: 'command', name: '/clear' })])).toEqual([]);
  });
});

describe('traceEntries', () => {
  test('starts with the Session’s start, cwd, and branch', () => {
    const entries = entriesOf(view({ branch: 'main', cwd: '/work' }));
    expect(entries).toEqual([{ at: T0, branch: 'main', cwd: '/work', kind: 'start' }]);
  });

  test('has a link entry at each stretch’s start', () => {
    const first = stretch({ startedAt: at(0) });
    const second = stretch({ startedAt: at(20) });
    const entries = entriesOf(view({ stretches: [first, second] }));
    expect(entries.filter((entry) => entry.kind === 'link')).toEqual([
      { at: at(0), kind: 'link', stretch: first },
      { at: at(20), kind: 'link', stretch: second },
    ]);
  });

  test('a main request carries the tool calls it made', () => {
    const asked = requestAt(1, { requestId: 'q1' });
    const bash = call({ at: at(1), requestId: 'q1' });
    const read = call({ at: at(1), name: 'Read', requestId: 'q1' });
    const other = call({ at: at(1), requestId: 'q2' });
    const slash = call({ at: at(1), kind: 'command', name: '/x', requestId: 'q1' });
    const entries = entriesOf(view({ requests: [asked], toolCalls: [bash, read, other, slash] }));
    expect(entries.find((entry) => entry.kind === 'request')).toEqual({
      at: at(1),
      kind: 'request',
      request: asked,
      toolCalls: [bash, read],
    });
  });

  test('subagent requests are not entries', () => {
    const entries = entriesOf(
      view({ agents: [agent('a')], requests: [requestAt(1, { agentId: 'a' })] }),
    );
    expect(entryKinds(entries)).toEqual(['start', 'subagent']);
  });

  test('a top-level subagent is an entry at its start, counting what is nested under it', () => {
    const source = view({
      agents: [
        agent('a', { startedAt: at(5) }),
        agent('b', { parentAgentId: 'a', startedAt: at(6) }),
        agent('c', { parentAgentId: 'b', startedAt: at(7) }),
        agent('d', { startedAt: at(8) }),
      ],
    });
    const lanes = agentLanes(source);
    const subagents = traceEntries(source, lanes).filter((entry) => entry.kind === 'subagent');
    expect(subagents.map((entry) => [entry.at, entry.nested])).toEqual([
      [at(5), 2],
      [at(8), 0],
    ]);
    expect(subagents[0]?.lane).toBe(lanes[1]);
  });

  test('a workflow agent is an entry too, and its nested agents are counted', () => {
    const source = view({
      agents: [
        agent('w', { startedAt: at(5), workflowRun: 'run-1' }),
        agent('k', { parentAgentId: 'w', startedAt: at(6), workflowRun: 'run-1' }),
      ],
    });
    const entries = entriesOf(source);
    expect(entries.filter((entry) => entry.kind === 'subagent')).toMatchObject([{ nested: 1 }]);
  });

  test('a main-conversation slash command is an entry; a subagent’s is not', () => {
    const entries = entriesOf(
      view({
        agents: [agent('a')],
        toolCalls: [
          call({ at: at(3), kind: 'command', name: '/review' }),
          call({ agentId: 'a', at: at(4), kind: 'command', name: '/other' }),
        ],
      }),
    );
    expect(entries.filter((entry) => entry.kind === 'command')).toEqual([
      { at: at(3), kind: 'command', name: '/review' },
    ]);
  });

  test('entering a skill is an entry before the first request in it, and not repeated', () => {
    const entries = entriesOf(
      view({
        requests: [
          requestAt(1),
          requestAt(2, { skill: 'review' }),
          requestAt(3, { skill: 'review' }),
          requestAt(4, { skill: 'deploy' }),
        ],
      }),
    );
    expect(entries.filter((entry) => entry.kind === 'skill')).toEqual([
      { at: at(2), kind: 'skill', skill: 'review' },
      { at: at(4), kind: 'skill', skill: 'deploy' },
    ]);
    expect(entryKinds(entries)).toEqual([
      'start',
      'request',
      'skill',
      'request',
      'request',
      'skill',
      'request',
    ]);
  });

  test('leaving a skill is not an entry, and neither is a skill on a subagent request', () => {
    const entries = entriesOf(
      view({
        agents: [agent('a')],
        requests: [
          requestAt(1, { skill: 'review' }),
          requestAt(2, { skill: undefined }),
          requestAt(3, { agentId: 'a', skill: 'other' }),
        ],
      }),
    );
    expect(entries.filter((entry) => entry.kind === 'skill')).toHaveLength(1);
  });

  test('a gap of at least PAUSE_MS between main requests is a pause at the earlier one', () => {
    const entries = entriesOf(
      view({
        requests: [
          requestAt(0, { stopReason: 'end_turn' }),
          requestAt(PAUSE_MS / MINUTE, { stopReason: 'tool_use' }),
          requestAt(PAUSE_MS / MINUTE + 10, { stopReason: 'tool_use' }),
        ],
      }),
    );
    expect(entries.filter((entry) => entry.kind === 'pause')).toEqual([
      { at: at(0), kind: 'pause', ms: PAUSE_MS, waiting: true },
      { at: at(PAUSE_MS / MINUTE), kind: 'pause', ms: 10 * MINUTE, waiting: false },
    ]);
  });

  test('a shorter gap is not a pause', () => {
    const entries = entriesOf(
      view({ requests: [requestAt(0), { ...requestAt(0), at: T0 + PAUSE_MS - 1 }] }),
    );
    expect(entryKinds(entries)).not.toContain('pause');
  });

  test('a gap is measured between main requests only', () => {
    const entries = entriesOf(
      view({
        agents: [agent('a')],
        requests: [requestAt(0), requestAt(5, { agentId: 'a' }), requestAt(10)],
      }),
    );
    expect(entries.filter((entry) => entry.kind === 'pause')).toMatchObject([{ ms: 10 * MINUTE }]);
  });

  test('entries are oldest first', () => {
    const entries = entriesOf(
      view({
        agents: [agent('a', { startedAt: at(7) })],
        requests: [requestAt(2), requestAt(1)],
        stretches: [stretch({ startedAt: at(4) })],
      }),
    );
    expect(entries.map((entry) => entry.at)).toEqual([T0, at(1), at(2), at(4), at(7)]);
  });

  test('entries at the same moment run start, link, command, skill, subagent, request, pause', () => {
    const entries = entriesOf(
      view({
        agents: [agent('a', { startedAt: T0 })],
        requests: [
          requestAt(0, { skill: 'review', stopReason: 'end_turn' }),
          requestAt(PAUSE_MS / MINUTE),
        ],
        stretches: [stretch({ startedAt: T0 })],
        toolCalls: [call({ at: T0, kind: 'command', name: '/go' })],
      }),
    );
    expect(entryKinds(entries.filter((entry) => entry.at === T0))).toEqual([
      'start',
      'link',
      'command',
      'skill',
      'subagent',
      'request',
      'pause',
    ]);
  });
});

describe('filterTrace', () => {
  const stretchEntry: TraceEntry = { at: at(0), kind: 'link', stretch: stretch() };
  const startEntry: TraceEntry = { at: at(0), branch: undefined, cwd: undefined, kind: 'start' };
  const plainRequest: TraceEntry = {
    at: at(1),
    kind: 'request',
    request: requestAt(1),
    toolCalls: [],
  };
  const toolRequest: TraceEntry = {
    at: at(2),
    kind: 'request',
    request: requestAt(2),
    toolCalls: [call()],
  };
  const subagentEntry: TraceEntry = { at: at(3), kind: 'subagent', lane: lane(), nested: 0 };
  const commandEntry: TraceEntry = { at: at(4), kind: 'command', name: '/x' };
  const skillEntry: TraceEntry = { at: at(5), kind: 'skill', skill: 'review' };
  const pauseEntry: TraceEntry = { at: at(6), kind: 'pause', ms: PAUSE_MS, waiting: false };
  const all = [
    startEntry,
    stretchEntry,
    plainRequest,
    toolRequest,
    subagentEntry,
    commandEntry,
    skillEntry,
    pauseEntry,
  ];

  test('everything keeps every entry', () => {
    expect(filterTrace(all, 'everything')).toEqual(all);
  });

  test('main keeps requests, commands, skills, and pauses, with start and links', () => {
    expect(filterTrace(all, 'main')).toEqual([
      startEntry,
      stretchEntry,
      plainRequest,
      toolRequest,
      commandEntry,
      skillEntry,
      pauseEntry,
    ]);
  });

  test('subagents keeps subagents, with start and links', () => {
    expect(filterTrace(all, 'subagents')).toEqual([startEntry, stretchEntry, subagentEntry]);
  });

  test('tools keeps requests that made tool calls, with start and links', () => {
    expect(filterTrace(all, 'tools')).toEqual([startEntry, stretchEntry, toolRequest]);
  });
});

describe('concurrentAt', () => {
  const sub = (agentId: string, minutes: number[]) =>
    lane({
      agentId,
      requests: minutes.map((minute) => requestAt(minute, { agentId })),
    });
  const main = lane({ requests: [requestAt(10), requestAt(10.5)] });

  test('counts each other lane’s requests within a minute either side, busiest first', () => {
    const found = concurrentAt(
      [main, sub('few', [10]), sub('many', [9.5, 10, 10.9]), sub('far', [20])],
      at(10),
      undefined,
    );
    expect(found.map((entry) => [entry.lane.agentId, entry.requests])).toEqual([
      ['many', 3],
      ['few', 1],
    ]);
  });

  test('a request exactly a minute away counts; one a moment further does not', () => {
    const edge = lane({
      agentId: 'e',
      requests: [
        request({ agentId: 'e', at: at(10) - MINUTE }),
        request({ agentId: 'e', at: at(10) + MINUTE + 1 }),
      ],
    });
    expect(concurrentAt([edge], at(10), undefined)[0]?.requests).toBe(1);
  });

  test('with no except, the main conversation is left out', () => {
    expect(concurrentAt([main], at(10), undefined)).toEqual([]);
  });

  test('with an except, that agent is left out and the main conversation is included', () => {
    const found = concurrentAt([main, sub('a', [10]), sub('b', [10])], at(10), 'a');
    expect(found.map((entry) => entry.lane.agentId)).toEqual([undefined, 'b']);
  });
});

describe('density', () => {
  const window = { from: at(0), to: at(10) };

  test('counts requests in equal slices of the window', () => {
    const bins = density(
      [requestAt(0), requestAt(1), requestAt(4.9), requestAt(5), requestAt(9)],
      window,
      2,
    );
    expect(bins).toEqual([3, 2]);
  });

  test('a request exactly at the end falls in the last bin', () => {
    expect(density([requestAt(10)], window, 5)).toEqual([0, 0, 0, 0, 1]);
  });

  test('requests outside the window are ignored', () => {
    expect(density([requestAt(-1), requestAt(10.5)], window, 4)).toEqual([0, 0, 0, 0]);
  });

  test('counts requests of every agent', () => {
    expect(density([requestAt(1), requestAt(1, { agentId: 'a' })], window, 1)).toEqual([2]);
  });
});

describe('stretchAt', () => {
  const first = stretch({ endedAt: at(10), startedAt: at(0) });
  const second = stretch({ endedAt: at(40), startedAt: at(30) });

  test('returns the stretch that holds the moment', () => {
    expect(stretchAt([first, second], at(5))).toBe(first);
    expect(stretchAt([first, second], at(35))).toBe(second);
  });

  test('in a gap, returns the latest stretch that started before', () => {
    expect(stretchAt([first, second], at(20))).toBe(first);
  });

  test('before every stretch, returns none', () => {
    expect(stretchAt([first, second], at(-1))).toBeUndefined();
    expect(stretchAt([], at(0))).toBeUndefined();
  });
});
