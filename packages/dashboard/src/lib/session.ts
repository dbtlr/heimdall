// What the Session page shows, derived from one Session's facts: its agents as
// lanes, where its cost went, and its Trace. Pure functions over SessionView.

import type {
  SessionAgent,
  SessionRequest,
  SessionStretch,
  SessionToolCall,
  SessionView,
} from '../server/session-view-types.ts';

// The main conversation, or one subagent, with its requests.
export type AgentLane = {
  // Undefined for the main conversation.
  agentId: string | undefined;
  agentType: string | undefined;
  // Undefined when any of its requests is unpriced.
  costUsd: number | undefined;
  // Indent: 0 for the main conversation, 1 for an agent the main conversation
  // or a workflow run started, one more for each parent above that.
  depth: number;
  endedAt: number;
  // Main conversation, or the agent type, or "Subagent" without one.
  label: string;
  // The model that answered most of its requests.
  model: string | undefined;
  phase: string | undefined;
  requests: SessionRequest[];
  startedAt: number;
  // Input and output tokens.
  tokens: number;
  toolCalls: number;
  workflowRun: string | undefined;
};

export type TokenKind = 'cacheRead' | 'cacheWrite' | 'input' | 'output';

export type KindCost = { costUsd: number; kind: TokenKind; tokens: number };

export type RunningCostPoint = { main: number; subagents: number; t: number };

export type ContextPoint = { t: number; tokens: number; window: number | undefined };

// A slash command, with the main conversation's context before and after it
// where it shrank: a compaction.
export type CommandMark = {
  after: number | undefined;
  at: number;
  before: number | undefined;
  name: string;
};

export type CostShare = {
  costUsd: number | undefined;
  // Undefined for requests outside any skill.
  key: string | undefined;
  requests: number;
};

export type ToolCount = { calls: number; mcpServer: string | undefined; name: string };

export type TraceFilter = 'everything' | 'main' | 'subagents' | 'tools';

export type TraceEntry =
  | { at: number; branch: string | undefined; cwd: string | undefined; kind: 'start' }
  | { at: number; kind: 'link'; stretch: SessionStretch }
  | { at: number; kind: 'request'; request: SessionRequest; toolCalls: SessionToolCall[] }
  // A subagent the main conversation or a workflow run started, with its
  // nested subagents counted, not listed.
  | { at: number; kind: 'subagent'; lane: AgentLane; nested: number }
  | { at: number; kind: 'command'; name: string }
  | { at: number; kind: 'skill'; skill: string }
  // No main-conversation request for `ms`; `waiting` when the request before
  // finished its turn, so the Harness was waiting on the person.
  | { at: number; kind: 'pause'; ms: number; waiting: boolean };

// Another agent at work near a moment, and its requests within a minute of it.
export type Concurrent = { lane: AgentLane; requests: number };

const MINUTE_MS = 60_000;

const byTime = (a: { at: number }, b: { at: number }): number => a.at - b.at;

const sum = (values: Iterable<number>): number => {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
};

// The total of the costs, undefined when any is.
const sumCosts = (costs: readonly (number | undefined)[]): number | undefined => {
  let total = 0;
  for (const cost of costs) {
    if (cost === undefined) {
      return undefined;
    }
    total += cost;
  }
  return total;
};

// The most common model, the first seen among equals.
const dominantModel = (requests: readonly SessionRequest[]): string | undefined => {
  const counts = new Map<string, number>();
  for (const request of requests) {
    counts.set(request.model, (counts.get(request.model) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
};

const isMain = (item: { agentId: string | undefined }): boolean => item.agentId === undefined;

type LaneIdentity = Pick<
  AgentLane,
  'agentId' | 'agentType' | 'depth' | 'endedAt' | 'label' | 'phase' | 'startedAt' | 'workflowRun'
>;

const laneOf = (
  identity: LaneIdentity,
  requests: SessionRequest[],
  toolCalls: readonly SessionToolCall[],
): AgentLane => ({
  ...identity,
  costUsd: sumCosts(requests.map((request) => request.costUsd)),
  model: dominantModel(requests),
  requests,
  tokens: sum(requests.map((request) => request.inputTokens + request.outputTokens)),
  toolCalls: toolCalls.filter((call) => call.kind === 'tool').length,
});

// Adds `item` to the list kept under `key`, starting the list when there is none.
const pushTo = <Key, Item>(groups: Map<Key, Item[]>, key: Key, item: Item): void => {
  const group = groups.get(key);
  if (group === undefined) {
    groups.set(key, [item]);
  } else {
    group.push(item);
  }
};

const byStart = (a: SessionAgent, b: SessionAgent): number => a.startedAt - b.startedAt;

// Top-level plain agents, then each workflow run's top-level agents, runs
// ordered by the start of their first.
const topLevelOrder = (roots: readonly SessionAgent[]): SessionAgent[] => {
  const sorted = roots.toSorted(byStart);
  const plain = sorted.filter((agent) => agent.workflowRun === undefined);
  const runs = new Map<string, SessionAgent[]>();
  for (const agent of sorted) {
    if (agent.workflowRun !== undefined) {
      pushTo(runs, agent.workflowRun, agent);
    }
  }
  const inRunOrder = [...runs.values()].toSorted((a, b) => byStart(a[0]!, b[0]!));
  return [...plain, ...inRunOrder.flat()];
};

// The main conversation first, then subagents outside workflow runs in start
// order with each one's children after it, then each workflow run's agents
// in start order, runs in order of their first start.
export const agentLanes = (view: SessionView): AgentLane[] => {
  const requestsOf = (agentId: string | undefined): SessionRequest[] =>
    view.requests.filter((request) => request.agentId === agentId).toSorted(byTime);
  const callsOf = (agentId: string | undefined) =>
    view.toolCalls.filter((call) => call.agentId === agentId);

  const mainRequests = requestsOf(undefined);
  const main = laneOf(
    {
      agentId: undefined,
      agentType: undefined,
      depth: 0,
      endedAt: mainRequests.at(-1)?.at ?? view.endedAt,
      label: 'Main conversation',
      phase: undefined,
      startedAt: mainRequests[0]?.at ?? view.startedAt,
      workflowRun: undefined,
    },
    mainRequests,
    callsOf(undefined),
  );

  // An agent whose parent is not in the list is top level.
  const known = new Set(view.agents.map((agent) => agent.agentId));
  const childrenOf = new Map<string, SessionAgent[]>();
  const roots: SessionAgent[] = [];
  for (const agent of view.agents.toSorted(byStart)) {
    const parent = agent.parentAgentId;
    if (parent !== undefined && known.has(parent)) {
      pushTo(childrenOf, parent, agent);
    } else {
      roots.push(agent);
    }
  }

  const subagents: AgentLane[] = [];
  // `run` is the workflow run whose group the agent is placed in, if any.
  const visit = (agent: SessionAgent, depth: number, run: string | undefined): void => {
    subagents.push(
      laneOf(
        {
          agentId: agent.agentId,
          agentType: agent.agentType,
          depth,
          endedAt: agent.endedAt,
          label: agent.agentType ?? 'Subagent',
          phase: agent.workflowPhase,
          startedAt: agent.startedAt,
          workflowRun: run,
        },
        requestsOf(agent.agentId),
        callsOf(agent.agentId),
      ),
    );
    for (const child of childrenOf.get(agent.agentId) ?? []) {
      visit(child, depth + 1, run);
    }
  };
  for (const root of topLevelOrder(roots)) {
    visit(root, 1, root.workflowRun);
  }
  return [main, ...subagents];
};

// Where each token kind's cost and tokens sit on a request.
const KIND_FIELDS: Record<
  TokenKind,
  {
    cost: (request: SessionRequest) => number | undefined;
    tokens: (request: SessionRequest) => number;
  }
> = {
  cacheRead: { cost: (r) => r.cacheReadCostUsd, tokens: (r) => r.cacheReadTokens },
  cacheWrite: { cost: (r) => r.cacheWriteCostUsd, tokens: (r) => r.cacheWriteTokens },
  input: { cost: (r) => r.inputCostUsd, tokens: (r) => r.inputTokens },
  output: { cost: (r) => r.outputCostUsd, tokens: (r) => r.outputTokens },
};

const TOKEN_KINDS: readonly TokenKind[] = ['input', 'output', 'cacheRead', 'cacheWrite'];

// The cost of each token kind over the priced requests, costliest first.
export const costByKind = (requests: readonly SessionRequest[]): KindCost[] => {
  const priced = requests.filter((request) => request.costUsd !== undefined);
  return TOKEN_KINDS.map((kind) => ({
    costUsd: sum(priced.map((request) => KIND_FIELDS[kind].cost(request) ?? 0)),
    kind,
    tokens: sum(priced.map((request) => KIND_FIELDS[kind].tokens(request))),
  })).toSorted((a, b) => b.costUsd - a.costUsd);
};

// The running list-price cost at each request, split between the main
// conversation and subagents; unpriced requests add nothing.
export const runningCost = (requests: readonly SessionRequest[]): RunningCostPoint[] => {
  let main = 0;
  let subagents = 0;
  return requests.toSorted(byTime).map((request) => {
    if (isMain(request)) {
      main += request.costUsd ?? 0;
    } else {
      subagents += request.costUsd ?? 0;
    }
    return { main, subagents, t: request.at };
  });
};

// The main conversation's context at each of its requests.
export const contextFill = (requests: readonly SessionRequest[]): ContextPoint[] =>
  requests.filter(isMain).map((request) => ({
    t: request.at,
    tokens: request.contextTokens,
    window: request.contextWindow,
  }));

const mainCommands = (toolCalls: readonly SessionToolCall[]): SessionToolCall[] =>
  toolCalls.filter((call) => call.kind === 'command' && isMain(call));

// The slash command that compacts the conversation, the only one that shrinks
// the context on purpose.
const COMPACT_COMMAND = 'compact';

// Each main-conversation slash command. For a compaction, `before` and `after`
// are the context of the main-conversation requests either side, set only when
// it shrank; other commands carry neither.
export const commandMarks = (
  requests: readonly SessionRequest[],
  toolCalls: readonly SessionToolCall[],
): CommandMark[] => {
  const main = requests.filter(isMain).toSorted(byTime);
  return mainCommands(toolCalls).map((command) => {
    const before = main.findLast((request) => request.at <= command.at);
    const after = main.find((request) => request.at > command.at);
    const shrank =
      command.name === COMPACT_COMMAND &&
      before !== undefined &&
      after !== undefined &&
      after.contextTokens < before.contextTokens;
    return {
      after: shrank ? after.contextTokens : undefined,
      at: command.at,
      before: shrank ? before.contextTokens : undefined,
      name: command.name,
    };
  });
};

// Cost and requests by model, or by skill, costliest first; a share with an
// unpriced request has an undefined cost and sorts last.
export const costBy = (
  requests: readonly SessionRequest[],
  key: 'model' | 'skill',
): CostShare[] => {
  const groups = new Map<string | undefined, SessionRequest[]>();
  for (const request of requests) {
    pushTo(groups, request[key], request);
  }
  const shares = [...groups].map(([groupKey, members]) => ({
    costUsd: sumCosts(members.map((member) => member.costUsd)),
    key: groupKey,
    requests: members.length,
  }));
  const priced = shares.filter((share) => share.costUsd !== undefined);
  const unpriced = shares.filter((share) => share.costUsd === undefined);
  return [
    ...priced.toSorted((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)),
    ...unpriced.toSorted((a, b) => b.requests - a.requests),
  ];
};

// Tool calls by tool, most first; slash commands are not tool calls.
export const toolCounts = (toolCalls: readonly SessionToolCall[]): ToolCount[] => {
  const counts = new Map<string, ToolCount>();
  for (const call of toolCalls) {
    if (call.kind !== 'tool') {
      continue;
    }
    const id = JSON.stringify([call.mcpServer, call.name]);
    const count = counts.get(id) ?? { calls: 0, mcpServer: call.mcpServer, name: call.name };
    count.calls += 1;
    counts.set(id, count);
  }
  return [...counts.values()].toSorted((a, b) => b.calls - a.calls);
};

// A pause in the main conversation shorter than this is not shown.
export const PAUSE_MS = 3 * 60_000;

// Entries at the same moment run in this order.
const TRACE_ORDER: Record<TraceEntry['kind'], number> = {
  command: 2,
  link: 1,
  pause: 6,
  request: 5,
  skill: 3,
  start: 0,
  subagent: 4,
};

// The lanes that descend from `lane`: the lanes are depth-first, so they are
// the run of deeper lanes right after it, up to the next that is not deeper.
export const descendantLanes = (lanes: readonly AgentLane[], lane: AgentLane): AgentLane[] => {
  const start = lanes.indexOf(lane) + 1;
  if (start === 0) {
    return [];
  }
  const end = lanes.findIndex((other, index) => index >= start && other.depth <= lane.depth);
  return lanes.slice(start, end === -1 ? undefined : end);
};

// The main conversation's requests with their tool calls, the skills it
// enters, and the pauses between requests.
const mainRequestEntries = (view: SessionView): TraceEntry[] => {
  const callsByRequest = new Map<string, SessionToolCall[]>();
  for (const call of view.toolCalls) {
    if (call.kind === 'tool' && call.requestId !== undefined) {
      pushTo(callsByRequest, call.requestId, call);
    }
  }
  const entries: TraceEntry[] = [];
  let previous: SessionRequest | undefined;
  for (const request of view.requests.filter(isMain).toSorted(byTime)) {
    if (request.skill !== undefined && request.skill !== previous?.skill) {
      entries.push({ at: request.at, kind: 'skill', skill: request.skill });
    }
    entries.push({
      at: request.at,
      kind: 'request',
      request,
      toolCalls: callsByRequest.get(request.requestId) ?? [],
    });
    if (previous !== undefined && request.at - previous.at >= PAUSE_MS) {
      entries.push({
        at: previous.at,
        kind: 'pause',
        ms: request.at - previous.at,
        waiting: previous.stopReason === 'end_turn',
      });
    }
    previous = request;
  }
  return entries;
};

// The Trace, oldest first: the start, each stretch's link, every
// main-conversation request with its tool calls, each top-level subagent at
// its start, slash commands, the main conversation entering a skill, and
// pauses of at least PAUSE_MS.
export const traceEntries = (view: SessionView, lanes: readonly AgentLane[]): TraceEntry[] => {
  const entries: TraceEntry[] = [
    { at: view.startedAt, branch: view.branch, cwd: view.cwd, kind: 'start' },
    ...view.stretches.map((stretch): TraceEntry => ({
      at: stretch.startedAt,
      kind: 'link',
      stretch,
    })),
    ...mainCommands(view.toolCalls).map((command): TraceEntry => ({
      at: command.at,
      kind: 'command',
      name: command.name,
    })),
    ...mainRequestEntries(view),
  ];
  for (const lane of lanes.filter((candidate) => candidate.depth === 1)) {
    entries.push({
      at: lane.startedAt,
      kind: 'subagent',
      lane,
      nested: descendantLanes(lanes, lane).length,
    });
  }
  return entries.toSorted((a, b) => a.at - b.at || TRACE_ORDER[a.kind] - TRACE_ORDER[b.kind]);
};

// The entries a filter keeps: main keeps requests, commands, skills, and
// pauses; subagents keeps subagents; tools keeps requests with tool calls.
// Start and link entries stay under every filter.
export const filterTrace = (entries: readonly TraceEntry[], filter: TraceFilter): TraceEntry[] => {
  const keeps = (entry: TraceEntry): boolean => {
    if (filter === 'everything' || entry.kind === 'start' || entry.kind === 'link') {
      return true;
    }
    if (filter === 'main') {
      return entry.kind !== 'subagent';
    }
    if (filter === 'subagents') {
      return entry.kind === 'subagent';
    }
    return entry.kind === 'request' && entry.toolCalls.length > 0;
  };
  return entries.filter(keeps);
};

// The other lanes with a request within a minute of `at`, busiest first.
export const concurrentAt = (
  lanes: readonly AgentLane[],
  at: number,
  except: string | undefined,
): Concurrent[] =>
  lanes
    .filter((lane) => lane.agentId !== except)
    .map((lane) => ({
      lane,
      requests: lane.requests.filter((request) => Math.abs(request.at - at) <= MINUTE_MS).length,
    }))
    .filter((found) => found.requests > 0)
    .toSorted((a, b) => b.requests - a.requests);

// Requests per bin across the window, for the Trace's density strip.
export const density = (
  requests: readonly SessionRequest[],
  window: { from: number; to: number },
  bins: number,
): number[] => {
  const counts = Array.from({ length: bins }, () => 0);
  const width = (window.to - window.from) / bins;
  for (const request of requests) {
    if (request.at < window.from || request.at > window.to) {
      continue;
    }
    const index = width > 0 ? Math.floor((request.at - window.from) / width) : 0;
    const bin = Math.min(index, bins - 1);
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts;
};

// The stretch that holds `at`, else the latest that started before it.
export const stretchAt = (
  stretches: readonly SessionStretch[],
  at: number,
): SessionStretch | undefined =>
  stretches.find((stretch) => stretch.startedAt <= at && at <= stretch.endedAt) ??
  stretches.findLast((stretch) => stretch.startedAt <= at);
