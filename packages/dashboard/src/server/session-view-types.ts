// The data the Session page renders: one agent Session's requests, subagents,
// tool calls, and process links, with the Vitals of its System over its span.
// Times are epoch milliseconds. No transcript content.

import type { CpuBucket, Link } from './fleet-overview-types.ts';
import type { ProcessSeries } from './system-detail-types.ts';

// The key every insight view starts with.
export type SessionKey = {
  harness: string;
  sessionId: string;
  source: string;
  system: string;
};

// A subagent of the Session. A workflow agent has a run and a phase, and no
// parent; a subagent the main conversation spawned has depth 1 and no parent.
export type SessionAgent = {
  agentId: string;
  agentType: string | undefined;
  depth: number;
  endedAt: number;
  parentAgentId: string | undefined;
  startedAt: number;
  workflowPhase: string | undefined;
  workflowRun: string | undefined;
};

// One request, its cost at list price split by token kind. Every cost is
// undefined when the model is unpriced.
export type SessionRequest = {
  // Undefined for the main conversation.
  agentId: string | undefined;
  at: number;
  cacheReadCostUsd: number | undefined;
  cacheReadTokens: number;
  cacheWriteCostUsd: number | undefined;
  cacheWriteTokens: number;
  contextTokens: number;
  contextWindow: number | undefined;
  costUsd: number | undefined;
  inputCostUsd: number | undefined;
  inputTokens: number;
  // The response has no stop reason: the person interrupted it.
  interrupted: boolean;
  model: string;
  outputCostUsd: number | undefined;
  outputTokens: number;
  requestId: string;
  skill: string | undefined;
  // The Harness's stop reason, such as end_turn or tool_use.
  stopReason: string | undefined;
};

// A tool call, or a slash command a person typed, which has no request.
export type SessionToolCall = {
  agentId: string | undefined;
  at: number;
  callId: string;
  kind: 'command' | 'tool';
  mcpServer: string | undefined;
  name: string;
  requestId: string | undefined;
};

// A stretch of the Session and the process the Hub links it to.
export type SessionStretch = {
  // How many processes could have run it.
  candidates: number;
  endedAt: number;
  link: Link;
  // Set only when linked.
  pid: number | undefined;
  processId: number | undefined;
  requests: number;
  startedAt: number;
};

export type SessionTotals = {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  // Undefined when any request is unpriced.
  costUsd: number | undefined;
  inputTokens: number;
  mainRequests: number;
  outputTokens: number;
  // The sum over priced requests.
  pricedCostUsd: number;
  requests: number;
  unpricedRequests: number;
};

export type SessionView = SessionKey & {
  agents: SessionAgent[];
  branch: string | undefined;
  // CPU busy over the span, in buckets `bucketMs` wide from the raw samples,
  // or the 5-minute rollups once the samples are pruned.
  bucketMs: number;
  cpu: CpuBucket[];
  cwd: string | undefined;
  endedAt: number;
  harnessVersion: string | undefined;
  // The cores of each process a stretch is linked to, in the same buckets.
  processes: ProcessSeries[];
  // Oldest first.
  requests: SessionRequest[];
  startedAt: number;
  stretches: SessionStretch[];
  timeZone: string;
  // Oldest first.
  toolCalls: SessionToolCall[];
  totals: SessionTotals;
};
