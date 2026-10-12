import { createHash } from 'node:crypto';

import {
  MAX_LINE_BYTES,
  isShaped,
  optionalOf,
  shapedOf,
  textOf,
  timeOf,
  tokensOf,
  UNATTRIBUTED_MODEL,
  UnreadableLineError,
} from './session-insight.ts';
import type { Batch, HarnessParser, Moment, Owner, Request, ToolCall } from './session-insight.ts';

// Reads Codex rollouts into the same facts as Claude Code. Identity comes
// from the first record, which must be session_meta, never a copied header.
export const CODEX_PARSER_VERSION = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Codex records response_id on token_usage_record. Ordinary response_item and
// item_completed lines identify items or turns, so those cannot be associated
// with an API response unless the line explicitly carries response_id.
export const requestIdOf = (line: unknown): string | null => {
  if (!isRecord(line) || !isRecord(line.payload)) {
    return null;
  }
  try {
    return optionalOf(line.payload.response_id, 'id');
  } catch (error) {
    if (error instanceof UnreadableLineError) {
      return null;
    }
    throw error;
  }
};

const decoder = new TextDecoder();
const NEWLINE = 10;

type State = {
  headerSeen: boolean;
  historyStart: number;
  moment: Moment | null;
  owner: Owner | null;
  turns: { contextWindow: number | null; id: string; model: string | null }[];
};

// State contains only facts needed to resume a batch, never message content.
const stateOf = (value: unknown): State => {
  const state = isRecord(value) ? value : {};
  const owner = isRecord(state.owner) ? state.owner : {};
  const moment = isRecord(state.moment) ? state.moment : {};
  const sessionId = optionalOf(owner.sessionId, 'id');
  return {
    headerSeen: state.headerSeen === true,
    historyStart: tokensOf(state.historyStart) ?? 0,
    moment:
      typeof moment.at === 'number'
        ? {
            at: moment.at,
            cwd: textOf(moment.cwd),
            gitBranch: textOf(moment.gitBranch),
            version: optionalOf(moment.version, 'version'),
          }
        : null,
    owner: sessionId === null ? null : { agentId: optionalOf(owner.agentId, 'id'), sessionId },
    turns: (Array.isArray(state.turns) ? state.turns : []).flatMap((t) => {
      if (!isRecord(t)) {
        return [];
      }
      const id = optionalOf(t.id, 'id');
      const model = optionalOf(t.model, 'name');
      return id === null ? [] : [{ contextWindow: tokensOf(t.contextWindow), id, model }];
    }),
  };
};

const updateTurn = (
  state: State,
  id: string,
  fields: { contextWindow?: number | null; model?: string },
) => {
  const previous = state.turns.find((t) => t.id === id);
  state.turns = [
    ...state.turns.filter((t) => t.id !== id),
    {
      contextWindow: fields.contextWindow ?? previous?.contextWindow ?? null,
      id,
      model: fields.model ?? previous?.model ?? null,
    },
  ].slice(-1000);
};

// Codex input includes its cache hits. The shared projection separates them
// so context_tokens can sum input, cache read, and cache write once.
const requestOf = (
  payload: Record<string, unknown>,
  at: number,
  offset: number,
  state: State,
): Request => {
  const requestId = optionalOf(payload.response_id, 'id');
  const turnId = optionalOf(payload.turn_id, 'id');
  const turn = state.turns.find((t) => t.id === turnId);
  const model = turn?.model ?? UNATTRIBUTED_MODEL;
  if (requestId === null || !isRecord(payload.usage)) {
    throw new UnreadableLineError('A request has no usage or id.');
  }
  const usage = payload.usage;
  const input = tokensOf(usage.input_tokens);
  const output = tokensOf(usage.output_tokens);
  const cacheRead = tokensOf(usage.cached_input_tokens) ?? 0;
  const cacheWrite = tokensOf(usage.cache_write_input_tokens) ?? 0;
  if (input === null || output === null || cacheRead + cacheWrite > input) {
    throw new UnreadableLineError('Request usage is incomplete or its cache exceeds input.');
  }
  const reasoning = tokensOf(usage.reasoning_output_tokens);
  if (reasoning !== null && reasoning > output) {
    throw new UnreadableLineError('Reasoning exceeds output.');
  }
  return {
    at,
    cacheRead,
    cacheWrite,
    cacheWrite1h: null,
    cacheWrite5m: null,
    contextWindow: turn?.contextWindow ?? null,
    input: input - cacheRead - cacheWrite,
    model,
    offset,
    output,
    reasoning,
    requestId,
    skill: null,
    stopReason: 'completed',
  };
};

// Item ids can be local to a thread. Namespacing also prevents an inferred
// skill's id from colliding with a Harness tool's id.
const factId = (thread: string, kind: string, id: string) =>
  createHash('sha256')
    .update(JSON.stringify([thread, kind, id]))
    .digest('hex');

const skillNames = (text: string) =>
  [...text.matchAll(/(?:^|\/)skills\/(?<name>[^/\s"']+)\/SKILL\.md\b/gu)].flatMap((m) =>
    m.groups?.name !== undefined && isShaped(m.groups.name, 'command') ? [m.groups.name] : [],
  );

const toolsOf = (
  payload: Record<string, unknown>,
  thread: string,
  at: number,
  offset: number,
): ToolCall[] => {
  if (!isRecord(payload.item)) {
    return [];
  }
  const item = payload.item;
  let name: string | null;
  let mcpServer: string | null = null;
  switch (item.type) {
    case 'CommandExecution':
    case 'FileChange': {
      name = item.type;
      break;
    }
    case 'CollabAgentToolCall': {
      name = optionalOf(item.tool, 'name');
      break;
    }
    case 'McpToolCall': {
      name = optionalOf(item.tool, 'name');
      mcpServer = optionalOf(item.server, 'name');
      if (mcpServer === null) {
        throw new UnreadableLineError('An MCP item has no shaped server.');
      }
      break;
    }
    default: {
      return [];
    }
  }
  const id = optionalOf(item.id, 'id');
  if (id === null || name === null) {
    throw new UnreadableLineError('A completed tool has no shaped id or name.');
  }
  const command = Array.isArray(item.command)
    ? item.command.filter((part): part is string => typeof part === 'string').join(' ')
    : '';
  const skills =
    item.type === 'CommandExecution' &&
    /(?:^|[\s;|&])(?:cat|sed|head|tail|less|more)\s/u.test(command)
      ? [...new Set(skillNames(command))]
      : [];
  const call: ToolCall = {
    at,
    callId: factId(thread, 'item', id),
    kind: 'tool',
    lineId: null,
    mcpServer,
    name,
    offset,
    requestId: null,
    skill: null,
    skillInferred: false,
  };
  return [
    call,
    ...skills.map((skill): ToolCall => ({
      at,
      callId: factId(thread, 'skill-read', `${id}:${skill}`),
      kind: 'tool',
      lineId: null,
      mcpServer: null,
      name: 'Skill',
      offset,
      requestId: null,
      skill,
      skillInferred: true,
    })),
  ];
};

const skillsOf = (
  payload: Record<string, unknown>,
  thread: string,
  at: number,
  offset: number,
): ToolCall[] => {
  if (payload.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) {
    return [];
  }
  const names = payload.content.flatMap((block) => {
    if (!isRecord(block) || typeof block.text !== 'string') {
      return [];
    }
    return [...block.text.matchAll(/<skill>\s*<name>(?<name>[^<]*)<\/name>/gu)].flatMap((m) =>
      m.groups?.name !== undefined && isShaped(m.groups.name, 'command') ? [m.groups.name] : [],
    );
  });
  return [...new Set(names)].map((skill): ToolCall => ({
    at,
    callId: factId(thread, 'skill-message', `${String(at)}:${skill}`),
    kind: 'tool',
    lineId: null,
    mcpServer: null,
    name: 'Skill',
    offset,
    requestId: null,
    skill,
    skillInferred: true,
  }));
};

// A trailing partial line waits for the next upload, as in the Claude Code
// parser. Lines past the cap are skipped without decoding them.
function* linesOf(content: Uint8Array, offset: number, complete: boolean) {
  let start = 0;
  while (start < content.byteLength) {
    const newline = content.indexOf(NEWLINE, start);
    const end = newline === -1 ? content.byteLength : newline;
    if (newline === -1 && !complete) {
      break;
    }
    let value: unknown;
    let unreadable = end - start > MAX_LINE_BYTES;
    try {
      value = unreadable ? null : JSON.parse(decoder.decode(content.subarray(start, end)));
    } catch {
      if (newline === -1) {
        break;
      }
      unreadable = true;
    }
    const next = newline === -1 ? end : end + 1;
    yield { end: offset + next, offset: offset + start, unreadable, value };
    start = next;
  }
}

export const codexParser: HarnessParser = {
  harness: 'codex',
  holds: (path) => (/^sessions\/(?:[^/]+\/)*rollout-[^/]+\.jsonl$/u.test(path) ? 'facts' : 'other'),
  parse: ({ complete, content, factLimit, offset, state: saved }) => {
    const state = stateOf(saved);
    const batch: Batch = {
      agent: null,
      atFactLimit: false,
      owner: state.owner,
      parsedThrough: offset,
      requests: [],
      span: null,
      toolCalls: [],
      transcript: true,
      unreadableLines: 0,
    };
    if (batch.owner?.agentId !== null && batch.owner !== null) {
      batch.agent = {
        agentType: null,
        depth: null,
        parentAgentId: null,
        parentThreadId: batch.owner.sessionId,
        toolUseId: null,
        workflowPhase: null,
        workflowRun: null,
      };
    }
    const requests = new Map<string, Request>();
    const calls = new Map<string, ToolCall>();
    for (const line of linesOf(content, offset, complete)) {
      if (requests.size + calls.size >= factLimit) {
        batch.atFactLimit = true;
        break;
      }
      batch.parsedThrough = line.end;
      try {
        if (line.unreadable) {
          state.headerSeen = true;
          throw new UnreadableLineError('A rollout line cannot be read.');
        }
        const value = line.value;
        if (!isRecord(value)) {
          if (!state.headerSeen) {
            state.headerSeen = true;
            throw new UnreadableLineError('A Session header is not an object.');
          }
          continue;
        }
        const header = value.type === 'session_meta';
        if (!state.headerSeen) {
          state.headerSeen = true;
          if (!header) {
            throw new UnreadableLineError('The first record is not a Session header.');
          }
        } else if (header) {
          continue;
        }
        if (!isRecord(value.payload)) {
          if (header) {
            throw new UnreadableLineError('A Session header has no payload.');
          }
          continue;
        }
        const at = timeOf(value.timestamp);
        if (header) {
          const id = shapedOf(value.payload.id, 'id');
          if (id.kind !== 'shaped' || at === undefined) {
            throw new UnreadableLineError('A Session has no shaped id or time.');
          }
          const parent = shapedOf(value.payload.parent_thread_id, 'id');
          if (
            parent.kind === 'misshapen' ||
            (parent.kind === 'shaped' && parent.value === id.value)
          ) {
            throw new UnreadableLineError('A subagent has no valid parent.');
          }
          const owner =
            parent.kind === 'shaped'
              ? { agentId: id.value, sessionId: parent.value }
              : { agentId: null, sessionId: id.value };
          const cutoff = tokensOf(value.payload.subagent_history_start_ordinal);
          const fork = shapedOf(value.payload.forked_from_id, 'id');
          if (fork.kind === 'misshapen' || (fork.kind === 'shaped' && cutoff === null)) {
            throw new UnreadableLineError('A fork has no reliable replay cutoff.');
          }
          const historyStart = cutoff ?? 0;
          const git = isRecord(value.payload.git) ? value.payload.git : {};
          const moment = {
            at,
            cwd: textOf(value.payload.cwd),
            gitBranch: textOf(git.branch),
            version: optionalOf(value.payload.cli_version, 'version'),
          };
          batch.owner = owner;
          state.owner = owner;
          state.historyStart = historyStart;
          if (parent.kind === 'shaped') {
            batch.agent = {
              agentType: null,
              depth: null,
              parentAgentId: null,
              parentThreadId: parent.value,
              toolUseId: null,
              workflowPhase: null,
              workflowRun: null,
            };
          }
          state.moment = moment;
        } else {
          if (value.type === 'session_meta') {
            continue;
          }
          if (state.historyStart > 0) {
            const ordinal = tokensOf(value.ordinal);
            if (ordinal === null) {
              throw new UnreadableLineError('A fork record has no ordinal.');
            }
            if (ordinal < state.historyStart) {
              continue;
            }
          }
        }
        if (value.type === 'turn_context') {
          const id = optionalOf(value.payload.turn_id, 'id');
          const model = optionalOf(value.payload.model, 'name');
          if (id !== null && model !== null) {
            updateTurn(state, id, { model });
          }
        }
        if (value.type === 'event_msg' && value.payload.type === 'token_count') {
          const info = isRecord(value.payload.info) ? value.payload.info : {};
          const current = state.turns.at(-1);
          if (current !== undefined && current.contextWindow === null) {
            updateTurn(state, current.id, { contextWindow: tokensOf(info.model_context_window) });
          }
        }
        if (value.type === 'event_msg' && value.payload.type === 'turn_started') {
          const id = optionalOf(value.payload.turn_id, 'id');
          if (id !== null) {
            updateTurn(state, id, { contextWindow: tokensOf(value.payload.model_context_window) });
          }
        }
        if (value.type === 'token_usage_record' && batch.owner !== null) {
          if (at === undefined) {
            throw new UnreadableLineError('A request has no time.');
          }
          const request = requestOf(value.payload, at, line.offset, state);
          requests.set(request.requestId, request);
        }
        if (batch.owner !== null && at !== undefined) {
          const thread = batch.owner.agentId ?? batch.owner.sessionId;
          let tools: ToolCall[] = [];
          if (value.type === 'event_msg' && value.payload.type === 'item_completed') {
            tools = toolsOf(value.payload, thread, at, line.offset);
          } else if (value.type === 'response_item') {
            tools = skillsOf(value.payload, thread, at, line.offset);
          }
          for (const call of tools) {
            if (!calls.has(call.callId)) {
              calls.set(call.callId, call);
            }
          }
        }
        if (at !== undefined && state.moment !== null) {
          const current = { ...state.moment, at };
          const span = batch.span;
          batch.span =
            span === null
              ? { first: current, last: current }
              : {
                  first: at < span.first.at ? current : span.first,
                  last: at >= span.last.at ? current : span.last,
                };
        }
      } catch (error) {
        if (!(error instanceof UnreadableLineError)) {
          throw error;
        }
        batch.unreadableLines += 1;
      }
    }
    batch.requests = [...requests.values()];
    batch.toolCalls = [...calls.values()];
    batch.state = state;
    return batch;
  },
  requestIdOf,
  version: CODEX_PARSER_VERSION,
};
