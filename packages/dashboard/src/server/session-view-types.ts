// The data the Session page renders: one agent Session's requests, subagents,
// tool calls, and process links, with the Vitals of its System over its span.
// Times are epoch milliseconds. No transcript content.

import type { CostClass } from '../lib/cost-roles.ts';
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
export type SessionAgent = EffectiveRole & {
  agentId: string;
  agentType: string | undefined;
  depth: number;
  endedAt: number;
  parentAgentId: string | undefined;
  startedAt: number;
  workflowPhase: string | undefined;
  workflowRun: string | undefined;
};

// A conversation's class as the Hub defines it (insight.conversation_roles),
// including a subagent the Hub holds no row for.
export type SessionConversation = {
  agentId: string;
  roleClass: CostClass;
  // The review seat; undefined for a class other than review or an unknown seat.
  seat: string | undefined;
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
  // The class of each subagent conversation with requests or a row.
  conversations: SessionConversation[];
  branch: string | undefined;
  // CPU busy over the span, in buckets `bucketMs` wide from the raw samples,
  // or the 5-minute rollups once the samples are pruned.
  bucketMs: number;
  cpu: CpuBucket[];
  cwd: string | undefined;
  endedAt: number;
  harnessVersion: string | undefined;
  launch: SessionLaunch;
  // The cores of each process a stretch is linked to, in the same buckets.
  processes: ProcessSeries[];
  // The repository's name, else the working directory's (ADR-0019).
  project: string | undefined;
  // Oldest first.
  requests: SessionRequest[];
  startedAt: number;
  stretches: SessionStretch[];
  // Oldest first.
  toolCalls: SessionToolCall[];
  totals: SessionTotals;
};

// Where a conversation's role came from (ADR-0025): a session tag, T3 Code's
// sub-agent preamble, or neither.
export type RoleSource = 'preamble' | 'tag';

// A conversation's role as the split reads it: its own, else the nearest one
// above it. The seat is set only for a review role, and undefined there when
// the seat is unknown.
export type EffectiveRole = {
  effectiveRole: string | undefined;
  effectiveSeat: string | undefined;
  roleClass: CostClass;
};

// A Session another Session's page names: where it ran, what it worked on, and when.
export type SessionPlace = SessionKey & {
  branch: string | undefined;
  endedAt: number | undefined;
  project: string | undefined;
  startedAt: number | undefined;
};

// The Session that launched this one, by its tag's parent id. Unresolved keeps
// the raw id: no held Session has it (unmatched), more than one does
// (ambiguous), or it names this Session itself (self).
export type SessionLauncher =
  | { session: SessionPlace; state: 'resolved' }
  | { id: string; state: 'ambiguous' | 'self' | 'unmatched' };

// One Session of a launch tree. The root has no parent.
export type TreeMember = SessionPlace & {
  // Undefined until the refresh stores the member's totals.
  costUsd: number | undefined;
  parent: SessionKey | undefined;
  pricedCostUsd: number;
  role: string | undefined;
  roleClass: CostClass;
  seat: string | undefined;
  totaled: boolean;
  unpricedRequests: number;
};

// The tree total over every member. `costUsd` is undefined when a request is
// unpriced or a member has no stored totals yet; `pricedCostUsd` then sums
// what is priced over the members that have them.
export type TreeTotal = {
  costUsd: number | undefined;
  missingSessions: number;
  pricedCostUsd: number;
  requests: number;
  sessions: number;
  unpricedRequests: number;
};

// The Session and every Session it launched, directly or through others.
export type LaunchTree = {
  // The Session itself first, then the rest oldest first.
  members: TreeMember[];
  total: TreeTotal;
};

// The Session's own role, its launcher, and the Sessions it launched.
export type SessionLaunch = EffectiveRole & {
  // Undefined when the Session's tag named no parent.
  launcher: SessionLauncher | undefined;
  role: string | undefined;
  roleSource: RoleSource | undefined;
  seat: string | undefined;
  // Undefined when the Session launched nothing.
  tree: LaunchTree | undefined;
};
