import {
  idOf,
  isName,
  MAX_ID_LENGTH,
  MAX_LINE_BYTES,
  textOf,
  timeOf,
  tokensOf,
  UnreadableLineError,
} from './session-insight.ts';
import type {
  AgentMeta,
  Batch,
  HarnessParser,
  Moment,
  Owner,
  Request,
  ToolCall,
} from './session-insight.ts';

// Reads Claude Code transcripts into Session insight (ADR-0014). Pure: it sees
// bytes and paths, never the database. The facts it relies on:
//
// - A main conversation is `projects/<project>/<session>.jsonl`, named by its
//   Session id. A resumed Session appends to the same file, so a file is one
//   Session however many times its Harness restarted.
// - A subagent is `<session>/subagents/agent-<id>.jsonl`, and a workflow
//   agent `<session>/subagents/workflows/wf_<run>/agent-<id>.jsonl`. Each has
//   a `.meta.json` beside it, uploaded whole, that names how it was spawned.
// - Each assistant line holds one content block and repeats its response's
//   usage under `message.id`. A line with a null `stop_reason` is partial; an
//   interrupted response has only partial lines.
// - Timestamps are not monotonic, and `cwd`, `gitBranch`, and `version` can
//   change within a file.
//
// A line with a value no transcript plausibly holds, or PostgreSQL cannot
// store, is unreadable and yields nothing (session-insight.ts holds the
// bounds). A command or skill name not shaped like one is dropped from a line
// that is otherwise read, and the line is counted unreadable.

// Bumping it rebuilds every Claude Code row from the archive (ADR-0014).
export const CLAUDE_CODE_PARSER_VERSION = 1;

export type ClaudeCodeFile =
  | { kind: 'agent-meta'; owner: Owner & { agentId: string }; workflowRun: string | null }
  | { kind: 'conversation'; owner: Owner }
  | { kind: 'other' };

const MAIN = /^projects\/[^/]+\/(?<session>[^/]+)\.jsonl$/u;
const AGENT =
  /^projects\/[^/]+\/(?<session>[^/]+)\/subagents\/(?:workflows\/(?<run>[^/]+)\/)?agent-(?<agent>[^/]+?)\.(?<ext>jsonl|meta\.json)$/u;

// What a file in a Claude Code source holds, from its path within the source.
// Tool outputs, workflow journals, and memory hold no conversation.
export const classifyClaudeCodePath = (path: string): ClaudeCodeFile => {
  const main = MAIN.exec(path)?.groups;
  if (main?.session !== undefined) {
    return main.session.length > MAX_ID_LENGTH
      ? { kind: 'other' }
      : { kind: 'conversation', owner: { agentId: null, sessionId: main.session } };
  }
  const agent = AGENT.exec(path)?.groups;
  if (agent?.session === undefined || agent.agent === undefined) {
    return { kind: 'other' };
  }
  if ([agent.session, agent.agent, agent.run ?? ''].some((id) => id.length > MAX_ID_LENGTH)) {
    return { kind: 'other' };
  }
  const owner = { agentId: agent.agent, sessionId: agent.session };
  return agent.ext === 'jsonl'
    ? { kind: 'conversation', owner }
    : { kind: 'agent-meta', owner, workflowRun: agent.run ?? null };
};

export type Conversation = Pick<
  Batch,
  'parsedThrough' | 'requests' | 'span' | 'toolCalls' | 'unreadableLines'
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const NEWLINE = '\n'.charCodeAt(0);
const decoder = new TextDecoder();

// Each whole line of `content` with its offset, and how far the whole lines
// reach. A last line without a newline is whole only when `complete` says no
// more content can follow it and it reads as JSON; otherwise it waits. A line
// longer than `MAX_LINE_BYTES` is unreadable, and is not decoded.
const linesOf = (content: Uint8Array, offset: number, complete: boolean) => {
  const lines: { offset: number; value: unknown }[] = [];
  let unreadable = 0;
  let start = 0;
  const read = (end: number) => {
    if (end - start > MAX_LINE_BYTES) {
      unreadable += 1;
      return;
    }
    const raw = decoder.decode(content.subarray(start, end));
    if (raw.trim() === '') {
      return;
    }
    try {
      lines.push({ offset: offset + start, value: JSON.parse(raw) });
    } catch {
      unreadable += 1;
    }
  };
  for (let end = content.indexOf(NEWLINE); end !== -1; end = content.indexOf(NEWLINE, start)) {
    read(end);
    start = end + 1;
  }
  if (complete && start < content.byteLength && content.byteLength - start <= MAX_LINE_BYTES) {
    const before = unreadable;
    read(content.byteLength);
    if (unreadable === before) {
      start = content.byteLength;
    } else {
      unreadable = before;
    }
  }
  return { lines, parsedThrough: offset + start, unreadable };
};

const momentOf = (line: Record<string, unknown>, at: number): Moment => ({
  at,
  cwd: textOf(line.cwd),
  gitBranch: textOf(line.gitBranch),
  version: textOf(line.version),
});

// A name field shaped like a name, or null; `dropped` says it held something else.
const nameOf = (value: unknown): { dropped: boolean; name: string | null } => {
  const name = textOf(value);
  return name === null || isName(name) ? { dropped: false, name } : { dropped: true, name: null };
};

const MCP_TOOL = /^mcp__(?<server>.+?)__./u;
const COMMAND = /<command-name>(?<name>[^<]*)<\/command-name>/gu;

// What one line yields. `dropped` says a name in it was not shaped like one
// and was left out, so the line counts as unreadable.
type LineFacts = {
  dropped: boolean;
  moment: Moment | undefined;
  request: Request | undefined;
  toolCalls: ToolCall[];
};

const toolCallsOf = (blocks: unknown[], request: Request, offset: number) => {
  let dropped = false;
  const calls = blocks.flatMap((block): ToolCall[] => {
    if (!isRecord(block) || block.type !== 'tool_use') {
      return [];
    }
    const callId = idOf(block.id);
    const name = idOf(block.name);
    if (callId === null || name === null) {
      return [];
    }
    const input = isRecord(block.input) ? block.input : {};
    const skill = name === 'Skill' ? nameOf(input.skill) : { dropped: false, name: null };
    if (skill.dropped) {
      dropped = true;
      return [];
    }
    return [
      {
        at: request.at,
        callId,
        kind: 'tool',
        mcpServer: MCP_TOOL.exec(name)?.groups?.server ?? null,
        name,
        offset,
        requestId: request.requestId,
        skill: skill.name,
      },
    ];
  });
  return { calls, dropped };
};

// The request an assistant line reports, or undefined for a line that reports
// none, such as a `<synthetic>` message no model answered.
const requestOf = (
  line: Record<string, unknown>,
  at: number | undefined,
  offset: number,
): LineFacts | undefined => {
  const message = isRecord(line.message) ? line.message : {};
  const requestId = idOf(message.id);
  const model = idOf(message.model);
  if (requestId === null || model === null || model === '<synthetic>') {
    return undefined;
  }
  if (at === undefined) {
    throw new UnreadableLineError('A response has no time.');
  }
  const usage = isRecord(message.usage) ? message.usage : {};
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const skill = nameOf(line.attributionSkill);
  const request: Request = {
    at,
    cacheRead: tokensOf(usage.cache_read_input_tokens) ?? 0,
    cacheWrite: tokensOf(usage.cache_creation_input_tokens) ?? 0,
    cacheWrite1h: split === undefined ? null : (tokensOf(split.ephemeral_1h_input_tokens) ?? 0),
    cacheWrite5m: split === undefined ? null : (tokensOf(split.ephemeral_5m_input_tokens) ?? 0),
    input: tokensOf(usage.input_tokens) ?? 0,
    model,
    offset,
    output: tokensOf(usage.output_tokens) ?? 0,
    reasoning: tokensOf(details.thinking_tokens),
    requestId,
    skill: skill.name,
    stopReason: idOf(message.stop_reason),
  };
  const blocks = Array.isArray(message.content) ? message.content : [];
  const { calls, dropped } = toolCallsOf(blocks, request, offset);
  return {
    dropped: dropped || skill.dropped,
    moment: momentOf(line, at),
    request,
    toolCalls: calls,
  };
};

// The slash commands a user line carries, each a call of its own. A command
// names no skill: a built-in such as `/doctor` is none.
const commandsOf = (line: Record<string, unknown>, at: number, offset: number) => {
  const uuid = idOf(line.uuid);
  const message = isRecord(line.message) ? line.message : {};
  if (uuid === null) {
    return { calls: [], dropped: false };
  }
  const texts =
    typeof message.content === 'string'
      ? [message.content]
      : (Array.isArray(message.content) ? message.content : []).flatMap((block) =>
          isRecord(block) && block.type === 'text' && typeof block.text === 'string'
            ? [block.text]
            : [],
        );
  const found = texts.flatMap((t) => [...t.matchAll(COMMAND)].map((m) => m.groups?.name ?? ''));
  const names = found.filter((name) => isName(name));
  const calls = names.map((name, i): ToolCall => ({
    at,
    callId: i === 0 ? uuid : `${uuid}#${String(i)}`,
    kind: 'command',
    mcpServer: null,
    name: textOf(name) ?? name,
    offset,
    requestId: null,
    skill: null,
  }));
  return { calls, dropped: names.length < found.length };
};

// What one line yields, or throws `UnreadableLineError`.
const readLine = (value: unknown, offset: number): LineFacts => {
  const nothing: LineFacts = {
    dropped: false,
    moment: undefined,
    request: undefined,
    toolCalls: [],
  };
  if (!isRecord(value)) {
    return nothing;
  }
  const at = timeOf(value.timestamp);
  if (value.type === 'assistant') {
    const read = requestOf(value, at, offset);
    if (read !== undefined) {
      return read;
    }
  }
  if (at === undefined) {
    return nothing;
  }
  const moment = momentOf(value, at);
  if (value.type !== 'user') {
    return { ...nothing, moment };
  }
  const { calls, dropped } = commandsOf(value, at, offset);
  return { dropped, moment, request: undefined, toolCalls: calls };
};

// A later line of a response replaces the one kept unless the kept line is
// final and the later one partial.
const replaces = (later: Request, kept: Request) =>
  later.stopReason !== null || kept.stopReason === null;

// Parses a conversation's transcript content that starts at byte `offset` of
// its generation. `complete` says the content reaches the end of what the Hub
// holds, so a last line without a newline can be read. Within this content a
// response counts once, from its last final line, and a tool call from its
// first line; the caller keeps those rules across batches and generations.
export const parseConversation = (
  content: Uint8Array,
  { complete, offset }: { complete: boolean; offset: number },
): Conversation => {
  const { lines, parsedThrough, unreadable } = linesOf(content, offset, complete);
  const requests = new Map<string, Request>();
  const toolCalls = new Map<string, ToolCall>();
  let span: Conversation['span'] = null;
  let unreadableLines = unreadable;
  for (const { offset: at, value } of lines) {
    let facts: LineFacts;
    try {
      facts = readLine(value, at);
    } catch (error) {
      if (!(error instanceof UnreadableLineError)) {
        throw error;
      }
      unreadableLines += 1;
      continue;
    }
    const { moment, request } = facts;
    if (facts.dropped) {
      unreadableLines += 1;
    }
    if (moment !== undefined) {
      span =
        span === null
          ? { first: moment, last: moment }
          : {
              first: moment.at < span.first.at ? moment : span.first,
              last: moment.at >= span.last.at ? moment : span.last,
            };
    }
    if (request !== undefined) {
      const kept = requests.get(request.requestId);
      if (kept === undefined || replaces(request, kept)) {
        requests.set(request.requestId, request);
      }
    }
    for (const call of facts.toolCalls) {
      if (!toolCalls.has(call.callId)) {
        toolCalls.set(call.callId, call);
      }
    }
  }
  return {
    parsedThrough,
    requests: [...requests.values()],
    span,
    toolCalls: [...toolCalls.values()],
    unreadableLines,
  };
};

// A subagent's metadata, or undefined when the file is not a JSON object or
// holds a value out of bounds.
export const parseAgentMeta = (content: string): Omit<AgentMeta, 'workflowRun'> | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    return {
      agentType: idOf(value.agentType),
      depth: tokensOf(value.spawnDepth, MAX_DEPTH),
      parentAgentId: idOf(value.parentAgentId),
      toolUseId: idOf(value.toolUseId),
      workflowPhase: textOf(value.workflowPhase),
    };
  } catch (error) {
    if (error instanceof UnreadableLineError) {
      return undefined;
    }
    throw error;
  }
};

// The deepest spawn depth a subagent's metadata may name.
const MAX_DEPTH = 1000;

// The Claude Code parser as the projection runs it. A `.meta.json` is read
// whole, from its first byte, once the Hub holds all of it.
export const claudeCodeParser: HarnessParser = {
  harness: 'claude-code',
  parse: ({ complete, content, offset, path }) => {
    const file = classifyClaudeCodePath(path);
    const nothing = { agent: null, requests: [], span: null, toolCalls: [], unreadableLines: 0 };
    switch (file.kind) {
      case 'conversation': {
        return {
          ...parseConversation(content, { complete, offset }),
          agent: null,
          owner: file.owner,
          transcript: true,
        };
      }
      case 'agent-meta': {
        const whole = complete && offset === 0;
        const meta =
          whole && content.byteLength <= MAX_LINE_BYTES
            ? parseAgentMeta(decoder.decode(content))
            : undefined;
        return {
          ...nothing,
          agent: meta === undefined ? null : { ...meta, workflowRun: file.workflowRun },
          owner: file.owner,
          parsedThrough: meta === undefined ? offset : content.byteLength,
          transcript: false,
          unreadableLines: whole && meta === undefined ? 1 : 0,
        };
      }
      case 'other': {
        return {
          ...nothing,
          owner: null,
          parsedThrough: offset + content.byteLength,
          transcript: false,
        };
      }
      default: {
        const _exhaustive: never = file;
        return _exhaustive;
      }
    }
  },
  reads: (path) => classifyClaudeCodePath(path).kind !== 'other',
  version: CLAUDE_CODE_PARSER_VERSION,
};
