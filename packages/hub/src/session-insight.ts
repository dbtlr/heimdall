import { storable } from './storable.ts';

// The Session insight every Harness's parser derives from transcripts, the
// shape of a parser, and the bounds every parser holds a line to, so the
// projection stores each Harness's facts the same way (ADR-0014).

// The conversation a file belongs to: a Session's main conversation, with no
// agent, or one of its subagents.
export type Owner = { agentId: string | null; sessionId: string };

// One API response. Its token counts are at most `MAX_TOKENS`. `reasoning` is within `output`, and `cacheWrite` is
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
// names a skill or a built-in command. `lineId` is, for a command, the id of
// the line it was typed on: the first line with a command under an id owns
// every command under it, so a later line with the same id adds none. It is
// null for a tool use.
export type ToolCall = {
  at: number;
  callId: string;
  kind: 'command' | 'tool';
  lineId: string | null;
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
// byte offset the next batch starts from, and `atFactLimit` says the parser
// stopped there because the batch held as many facts as it was asked for.
export type Batch = {
  agent: AgentMeta | null;
  atFactLimit: boolean;
  owner: Owner | null;
  parsedThrough: number;
  requests: Request[];
  span: Span | null;
  toolCalls: ToolCall[];
  transcript: boolean;
  unreadableLines: number;
};

// What a file holds, from its path: facts to parse; nothing, as a file of
// another kind does; or nothing because it is misnamed: its path names what
// would own its facts by a name shaped as no id, such as prose.
export type FileKind = 'facts' | 'misnamed' | 'other';

// A Harness's parser. `holds` says what a file at `path` holds; one that
// holds no facts is never read. `parse` reads content from byte
// `offset` of its generation; `complete` says it reaches the end of what the
// Hub holds. It stops after the line at which the batch holds `factLimit`
// requests and tool calls. Bumping
// `version` rebuilds the Harness's rows (ADR-0014).
export type HarnessParser = {
  harness: string;
  holds: (path: string) => FileKind;
  parse: (input: {
    complete: boolean;
    content: Uint8Array;
    factLimit: number;
    offset: number;
    path: string;
  }) => Batch;
  version: number;
};

// The bounds a line is held to. A line longer than `MAX_LINE_BYTES` is
// unreadable, and is skipped without being held whole. An id or a name is at
// most `MAX_ID_LENGTH` code units, which keeps every key PostgreSQL indexes
// within its limit, and other text at most `MAX_TEXT_LENGTH`. A token count is
// a whole number from 0 to `MAX_TOKENS`, far above any context window, so no
// Session's sum nears bigint's range. A time is within the years 1 to 9999.
export const MAX_LINE_BYTES = 16 * 2 ** 20;
export const MAX_ID_LENGTH = 255;
export const MAX_TEXT_LENGTH = 4096;
export const MAX_TOKENS = 1_000_000_000;
const EARLIEST = Date.parse('0001-01-01T00:00:00.000Z');
const LATEST = Date.parse('9999-12-31T23:59:59.999Z');

// Thrown by the readers below for a value a line cannot hold, which makes the
// line unreadable. A parser catches it per line.
export class UnreadableLineError extends Error {
  override name = 'UnreadableLineError';
}

// A string field as it can be stored, or null when the field is not a string.
export const textOf = (value: unknown, maxLength = MAX_TEXT_LENGTH): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  if (value.length > maxLength) {
    throw new UnreadableLineError(`A text field is longer than ${String(maxLength)}.`);
  }
  return storable(value);
};

// A token count, or null when the field is absent.
export const tokensOf = (value: unknown, max = MAX_TOKENS): number | null => {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new UnreadableLineError('A count is not a whole number within its bounds.');
  }
  return value;
};

// A time field in epoch milliseconds, or undefined when the field is absent.
export const timeOf = (value: unknown): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const at = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(at) || at < EARLIEST || at > LATEST) {
    throw new UnreadableLineError('A time does not parse, or is out of range.');
  }
  return at;
};

// The shapes a field that names or identifies something takes, so no prose
// a line carries there reaches the views:
//
// - `command`: a command or skill, a letter or digit followed by at most 63
//   letters, digits, and `:_./-`, after an optional `/`.
// - `name`: a model, tool, MCP server, agent type, workflow phase, or stop
//   reason, a letter or digit followed by letters, digits, and `:_./@+-`.
// - `id`: a letter or digit followed by letters, digits, and `_.:-`.
// - `version`: a digit followed by letters, digits, and `.+-`.
const SHAPES = {
  command: /^\/?[A-Za-z0-9][A-Za-z0-9:_./-]{0,63}$/u,
  id: /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u,
  name: /^[A-Za-z0-9][A-Za-z0-9:_./@+-]*$/u,
  version: /^[0-9][0-9A-Za-z.+-]*$/u,
} as const;

export type Shape = keyof typeof SHAPES;

// Whether `value` takes `shape`.
export const isShaped = (value: string, shape: Shape): boolean => SHAPES[shape].test(value);

// A field that names or identifies something: absent when it is not a
// string, misshapen when it holds anything not shaped as `shape`, such as
// prose. Longer than `MAX_ID_LENGTH`, it makes the line unreadable.
export type Shaped = { kind: 'absent' } | { kind: 'misshapen' } | { kind: 'shaped'; value: string };

export const shapedOf = (value: unknown, shape: Shape): Shaped => {
  const text = textOf(value, MAX_ID_LENGTH);
  if (text === null) {
    return { kind: 'absent' };
  }
  return isShaped(text, shape) ? { kind: 'shaped', value: text } : { kind: 'misshapen' };
};

// A field no fact needs: its value when shaped as `shape`, and otherwise null.
export const optionalOf = (value: unknown, shape: Shape): string | null => {
  const shaped = shapedOf(value, shape);
  return shaped.kind === 'shaped' ? shaped.value : null;
};
