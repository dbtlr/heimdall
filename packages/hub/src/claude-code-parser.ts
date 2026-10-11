import { createHash } from 'node:crypto';

import {
  isShaped,
  MAX_ID_LENGTH,
  MAX_LINE_BYTES,
  optionalOf,
  shapedOf,
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
  'atFactLimit' | 'parsedThrough' | 'requests' | 'span' | 'toolCalls' | 'unreadableLines'
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const NEWLINE = '\n'.charCodeAt(0);
const decoder = new TextDecoder();

type Line =
  | { end: number; kind: 'blank' }
  | { end: number; kind: 'json'; offset: number; value: unknown }
  | { end: number; kind: 'unreadable' };

// Each whole line of `content` in order, with the offset where the next one
// starts: blank, its JSON and its offset, or unreadable, for a line that is
// not JSON or is longer than `MAX_LINE_BYTES`, which is not decoded. A last
// line without a newline is whole only when `complete` says no more content
// can follow it and it reads as JSON; otherwise it waits.
function* linesOf(content: Uint8Array, offset: number, complete: boolean): Generator<Line> {
  const read = (start: number, end: number, next: number): Line => {
    if (end - start > MAX_LINE_BYTES) {
      return { end: offset + next, kind: 'unreadable' };
    }
    const raw = decoder.decode(content.subarray(start, end));
    if (raw.trim() === '') {
      return { end: offset + next, kind: 'blank' };
    }
    try {
      return { end: offset + next, kind: 'json', offset: offset + start, value: JSON.parse(raw) };
    } catch {
      return { end: offset + next, kind: 'unreadable' };
    }
  };
  let start = 0;
  for (let end = content.indexOf(NEWLINE); end !== -1; end = content.indexOf(NEWLINE, start)) {
    yield read(start, end, end + 1);
    start = end + 1;
  }
  if (complete && start < content.byteLength && content.byteLength - start <= MAX_LINE_BYTES) {
    const last = read(start, content.byteLength, content.byteLength);
    if (last.kind !== 'unreadable') {
      yield last;
    }
  }
}

const momentOf = (line: Record<string, unknown>, at: number): Moment => ({
  at,
  cwd: textOf(line.cwd),
  gitBranch: textOf(line.gitBranch),
  version: optionalOf(line.version, 'version'),
});

const MCP_TOOL = /^mcp__(?<server>.+?)__./u;
const COMMAND = /<command-name>(?<name>[^<]*)<\/command-name>/gu;

// What one line yields. `dropped` says a fact in it was left out because a
// value the fact needs was not shaped as it must be, so the line counts as
// unreadable.
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
    const callId = shapedOf(block.id, 'id');
    const name = shapedOf(block.name, 'name');
    if (callId.kind !== 'shaped' || name.kind !== 'shaped') {
      dropped ||= callId.kind === 'misshapen' || name.kind === 'misshapen';
      return [];
    }
    const server = MCP_TOOL.exec(name.value)?.groups?.server;
    if (server !== undefined && !isShaped(server, 'name')) {
      dropped = true;
      return [];
    }
    const input = isRecord(block.input) ? block.input : {};
    return [
      {
        at: request.at,
        callId: callId.value,
        kind: 'tool',
        lineId: null,
        mcpServer: server ?? null,
        name: name.value,
        offset,
        requestId: request.requestId,
        skill: name.value === 'Skill' ? optionalOf(input.skill, 'command') : null,
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
  const requestId = shapedOf(message.id, 'id');
  const model = textOf(message.model, MAX_ID_LENGTH);
  if (requestId.kind === 'absent' || model === null || model === '<synthetic>') {
    return undefined;
  }
  if (at === undefined) {
    throw new UnreadableLineError('A response has no time.');
  }
  if (requestId.kind === 'misshapen' || !isShaped(model, 'name')) {
    return { dropped: true, moment: momentOf(line, at), request: undefined, toolCalls: [] };
  }
  const usage = isRecord(message.usage) ? message.usage : {};
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
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
    requestId: requestId.value,
    skill: optionalOf(line.attributionSkill, 'command'),
    stopReason: optionalOf(message.stop_reason, 'name'),
  };
  const blocks = Array.isArray(message.content) ? message.content : [];
  const { calls, dropped } = toolCallsOf(blocks, request, offset);
  return { dropped, moment: momentOf(line, at), request, toolCalls: calls };
};

// The id of the `index`th command on line `uuid`: the uuid itself for the
// first, and the uuid and its index after it for the rest, or, past
// `MAX_ID_LENGTH`, the uuid's SHA-256 and the index. No id a line carries
// holds `#`, so none is mistaken for another.
const commandId = (uuid: string, index: number) => {
  if (index === 0) {
    return uuid;
  }
  const id = `${uuid}#${String(index)}`;
  return id.length <= MAX_ID_LENGTH
    ? id
    : `${createHash('sha256').update(uuid).digest('hex')}#${String(index)}`;
};

// The slash commands a user line carries, each a call of its own. A command
// names no skill: a built-in such as `/doctor` is none. A command not shaped
// like one is left out, and so is every command of a line whose uuid is not
// shaped like an id.
const commandsOf = (line: Record<string, unknown>, at: number, offset: number) => {
  const uuid = shapedOf(line.uuid, 'id');
  const message = isRecord(line.message) ? line.message : {};
  if (uuid.kind === 'absent') {
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
  if (uuid.kind === 'misshapen') {
    return { calls: [], dropped: found.length > 0 };
  }
  const names = found.filter((name) => isShaped(name, 'command'));
  const calls = names.map((name, i): ToolCall => ({
    at,
    callId: commandId(uuid.value, i),
    kind: 'command',
    lineId: uuid.value,
    mcpServer: null,
    name,
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
// holds, so a last line without a newline can be read. It stops after the
// line at which it holds `factLimit` requests and tool calls, and
// `atFactLimit` says it did, so a batch's facts stay bounded; a line is never
// split. Within this content a response counts once, from its last final
// line; a tool call from its first line; and the commands under a line's id
// from the first line with any. The caller keeps those rules across batches
// and generations.
export const parseConversation = (
  content: Uint8Array,
  {
    complete,
    factLimit = Number.POSITIVE_INFINITY,
    offset,
  }: { complete: boolean; factLimit?: number; offset: number },
): Conversation => {
  const requests = new Map<string, Request>();
  const toolCalls = new Map<string, ToolCall>();
  // The lines whose commands are kept, by id: the first with a command under each.
  const commandLines = new Set<string>();
  let span: Conversation['span'] = null;
  let unreadableLines = 0;
  let parsedThrough = offset;
  let atFactLimit = false;
  for (const line of linesOf(content, offset, complete)) {
    if (requests.size + toolCalls.size >= factLimit) {
      atFactLimit = true;
      break;
    }
    parsedThrough = line.end;
    if (line.kind !== 'json') {
      unreadableLines += line.kind === 'unreadable' ? 1 : 0;
      continue;
    }
    let facts: LineFacts;
    try {
      facts = readLine(line.value, line.offset);
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
      if (!toolCalls.has(call.callId) && !(call.lineId !== null && commandLines.has(call.lineId))) {
        toolCalls.set(call.callId, call);
      }
    }
    for (const call of facts.toolCalls) {
      if (call.lineId !== null) {
        commandLines.add(call.lineId);
      }
    }
  }
  return {
    atFactLimit,
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
      agentType: optionalOf(value.agentType, 'name'),
      depth: tokensOf(value.spawnDepth, MAX_DEPTH),
      parentAgentId: optionalOf(value.parentAgentId, 'id'),
      toolUseId: optionalOf(value.toolUseId, 'id'),
      workflowPhase: optionalOf(value.workflowPhase, 'name'),
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
  parse: ({ complete, content, factLimit, offset, path }) => {
    const file = classifyClaudeCodePath(path);
    const nothing = {
      agent: null,
      atFactLimit: false,
      requests: [],
      span: null,
      toolCalls: [],
      unreadableLines: 0,
    };
    switch (file.kind) {
      case 'conversation': {
        return {
          ...parseConversation(content, { complete, factLimit, offset }),
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
