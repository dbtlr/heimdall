import type {
  AgentMeta,
  Batch,
  HarnessParser,
  Moment,
  Owner,
  Request,
  ToolCall,
} from './session-facts.ts';

// Reads Claude Code transcripts into Session facts (ADR-0014). Pure: it sees
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
    return { kind: 'conversation', owner: { agentId: null, sessionId: main.session } };
  }
  const agent = AGENT.exec(path)?.groups;
  if (agent?.session === undefined || agent.agent === undefined) {
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

const text = (value: unknown) => (typeof value === 'string' ? value : null);

const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const NEWLINE = '\n'.charCodeAt(0);
const decoder = new TextDecoder();

// Each whole line of `content` with its offset, and how far the whole lines
// reach. A last line without a newline is whole only when `complete` says no
// more content can follow it and it reads as JSON; otherwise it waits.
const linesOf = (content: Uint8Array, offset: number, complete: boolean) => {
  const lines: { offset: number; value: unknown }[] = [];
  let unreadable = 0;
  let start = 0;
  const read = (end: number) => {
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
  if (complete && start < content.byteLength) {
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

const momentOf = (line: Record<string, unknown>): Moment | undefined => {
  const at = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : Number.NaN;
  if (Number.isNaN(at)) {
    return undefined;
  }
  return { at, cwd: text(line.cwd), gitBranch: text(line.gitBranch), version: text(line.version) };
};

const MCP_TOOL = /^mcp__(?<server>.+?)__./u;
const COMMAND = /<command-name>(?<name>[^<]+)<\/command-name>/gu;

const toolCallsOf = (blocks: unknown[], request: Request, offset: number): ToolCall[] =>
  blocks.flatMap((block) => {
    if (!isRecord(block) || block.type !== 'tool_use') {
      return [];
    }
    const callId = text(block.id);
    const name = text(block.name);
    if (callId === null || name === null) {
      return [];
    }
    const input = isRecord(block.input) ? block.input : {};
    return [
      {
        at: request.at,
        callId,
        kind: 'tool' as const,
        mcpServer: MCP_TOOL.exec(name)?.groups?.server ?? null,
        name,
        offset,
        requestId: request.requestId,
        skill: name === 'Skill' ? text(input.skill) : null,
      },
    ];
  });

// The request an assistant line reports, or undefined for a line that reports
// none, such as a `<synthetic>` message no model answered.
const requestOf = (line: Record<string, unknown>, at: number, offset: number) => {
  const message = isRecord(line.message) ? line.message : {};
  const requestId = text(message.id);
  const model = text(message.model);
  if (requestId === null || model === null || model === '<synthetic>') {
    return undefined;
  }
  const usage = isRecord(message.usage) ? message.usage : {};
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : undefined;
  const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const request: Request = {
    at,
    cacheRead: count(usage.cache_read_input_tokens) ?? 0,
    cacheWrite: count(usage.cache_creation_input_tokens) ?? 0,
    cacheWrite1h: split === undefined ? null : (count(split.ephemeral_1h_input_tokens) ?? 0),
    cacheWrite5m: split === undefined ? null : (count(split.ephemeral_5m_input_tokens) ?? 0),
    input: count(usage.input_tokens) ?? 0,
    model,
    offset,
    output: count(usage.output_tokens) ?? 0,
    reasoning: count(details.thinking_tokens),
    requestId,
    skill: text(line.attributionSkill),
    stopReason: text(message.stop_reason),
  };
  const blocks = Array.isArray(message.content) ? message.content : [];
  return { request, toolCalls: toolCallsOf(blocks, request, offset) };
};

// The slash commands a user line carries, each a call of its own.
const commandsOf = (line: Record<string, unknown>, at: number, offset: number): ToolCall[] => {
  const uuid = text(line.uuid);
  const message = isRecord(line.message) ? line.message : {};
  if (uuid === null) {
    return [];
  }
  const texts =
    typeof message.content === 'string'
      ? [message.content]
      : (Array.isArray(message.content) ? message.content : []).flatMap((block) =>
          isRecord(block) && block.type === 'text' && typeof block.text === 'string'
            ? [block.text]
            : [],
        );
  const names = texts.flatMap((t) => [...t.matchAll(COMMAND)].flatMap((m) => m.groups?.name ?? []));
  return names.map((name, i) => ({
    at,
    callId: i === 0 ? uuid : `${uuid}#${String(i)}`,
    kind: 'command' as const,
    mcpServer: null,
    name,
    offset,
    requestId: null,
    skill: name.replace(/^\//u, ''),
  }));
};

// A later line of a response replaces the one kept unless the kept line is
// final and the later one partial.
const replaces = (later: Request, kept: Request) =>
  later.stopReason !== null || kept.stopReason === null;

// Parses a conversation's transcript content that starts at byte `offset` of
// its generation. `complete` says the content reaches the end of what the Hub
// holds, so a last line without a newline can be read. Within this content a
// response counts once, from its last final line; the caller keeps that rule
// across batches and generations.
export const parseConversation = (
  content: Uint8Array,
  { complete, offset }: { complete: boolean; offset: number },
): Conversation => {
  const { lines, parsedThrough, unreadable } = linesOf(content, offset, complete);
  const requests = new Map<string, Request>();
  const toolCalls = new Map<string, ToolCall>();
  let span: Conversation['span'] = null;
  for (const { offset: at, value } of lines) {
    if (!isRecord(value)) {
      continue;
    }
    const moment = momentOf(value);
    if (moment === undefined) {
      continue;
    }
    span =
      span === null
        ? { first: moment, last: moment }
        : {
            first: moment.at < span.first.at ? moment : span.first,
            last: moment.at >= span.last.at ? moment : span.last,
          };
    if (value.type === 'assistant') {
      const read = requestOf(value, moment.at, at);
      if (read === undefined) {
        continue;
      }
      const kept = requests.get(read.request.requestId);
      if (kept === undefined || replaces(read.request, kept)) {
        requests.set(read.request.requestId, read.request);
      }
      for (const call of read.toolCalls) {
        if (!toolCalls.has(call.callId)) {
          toolCalls.set(call.callId, call);
        }
      }
    } else if (value.type === 'user') {
      for (const call of commandsOf(value, moment.at, at)) {
        toolCalls.set(call.callId, call);
      }
    }
  }
  return {
    parsedThrough,
    requests: [...requests.values()],
    span,
    toolCalls: [...toolCalls.values()],
    unreadableLines: unreadable,
  };
};

// A subagent's metadata, or undefined when the file is not a JSON object.
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
  return {
    agentType: text(value.agentType),
    depth: count(value.spawnDepth),
    parentAgentId: text(value.parentAgentId),
    toolUseId: text(value.toolUseId),
    workflowPhase: text(value.workflowPhase),
  };
};

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
        const meta = complete && offset === 0 ? parseAgentMeta(decoder.decode(content)) : undefined;
        return {
          ...nothing,
          agent: meta === undefined ? null : { ...meta, workflowRun: file.workflowRun },
          owner: file.owner,
          parsedThrough: meta === undefined ? offset : content.byteLength,
          transcript: false,
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
