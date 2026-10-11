// The facts every Harness's parser derives from transcripts, and the shape of
// a parser, so the projection stores each Harness's facts the same way
// (ADR-0014).

// The conversation a file belongs to: a Session's main conversation, with no
// agent, or one of its subagents.
export type Owner = { agentId: string | null; sessionId: string };

// One API response. `reasoning` is within `output`, and `cacheWrite` is
// `cacheWrite5m` plus `cacheWrite1h` when the Harness splits it. `requestId`
// is the Harness's own id for the response, which counts it once however
// many files or generations hold it. `offset` is the byte offset of the line
// it was read from, in the generation's uncompressed content.
export type Request = {
  at: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number | null;
  cacheWrite5m: number | null;
  input: number;
  model: string;
  offset: number;
  output: number;
  reasoning: number | null;
  requestId: string;
  skill: string | null;
  stopReason: string | null;
};

// One tool use by a response, or one slash command a person typed, which
// names a skill or a built-in command.
export type ToolCall = {
  at: number;
  callId: string;
  kind: 'command' | 'tool';
  mcpServer: string | null;
  name: string;
  offset: number;
  requestId: string | null;
  skill: string | null;
};

// Where a conversation was at a moment: its directory, branch, and Harness version.
export type Moment = {
  at: number;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
};

// The earliest and the latest moment a batch of lines holds.
export type Span = { first: Moment; last: Moment };

// How a subagent was spawned: by its parent's tool call `toolUseId`, or by a
// workflow run's phase. A nested subagent may name its parent agent.
export type AgentMeta = {
  agentType: string | null;
  depth: number | null;
  parentAgentId: string | null;
  toolUseId: string | null;
  workflowPhase: string | null;
  workflowRun: string | null;
};

// What a parser made of one batch of a generation's content. `transcript`
// says the file is its owner's own transcript, so the owner's row names its
// path; `span` covers the conversation lines read. `parsedThrough` is the
// byte offset the next batch starts from.
export type Batch = {
  agent: AgentMeta | null;
  owner: Owner | null;
  parsedThrough: number;
  requests: Request[];
  span: Span | null;
  toolCalls: ToolCall[];
  transcript: boolean;
  unreadableLines: number;
};

// A Harness's parser. `reads` says whether a file at `path` holds facts at
// all; one that does not is never read. `parse` reads content from byte
// `offset` of its generation; `complete` says it reaches the end of what the
// Hub holds. Bumping `version` rebuilds the Harness's rows (ADR-0014).
export type HarnessParser = {
  harness: string;
  parse: (input: { complete: boolean; content: Uint8Array; offset: number; path: string }) => Batch;
  reads: (path: string) => boolean;
  version: number;
};
