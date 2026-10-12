// Synthetic rollouts pin the fields measured in Codex 0.154.0–0.162.1.
// Prompts and tool output are mock content, never copied transcripts.
export const SESSION = '01990000-0000-7000-8000-000000000001';
export const CHILD = '01990000-0000-7000-8000-000000000002';
export const NESTED = '01990000-0000-7000-8000-000000000003';
export const at = (second: number) => new Date(Date.UTC(2026, 9, 6, 12, 0, second)).toISOString();
export const rolloutPath = (id = SESSION) =>
  `sessions/2026/10/06/rollout-2026-10-06T12-00-00-${id}.jsonl`;
export const jsonl = (lines: Record<string, unknown>[]) =>
  `${lines.map((line, ordinal) => JSON.stringify({ ordinal, ...line })).join('\n')}\n`;
export const meta = ({ id = SESSION, version = '0.162.1' } = {}) => ({
  payload: { cli_version: version, cwd: '/work/project', id, source: 'cli', timestamp: at(0) },
  timestamp: at(0),
  type: 'session_meta',
});

export const turn = (id: string, model = 'gpt-5.4', second = 1) => ({
  payload: { cwd: '/work/project', model, turn_id: id },
  timestamp: at(second),
  type: 'turn_context',
});

export const usage = (response: string, turnId: string, second = 2, threadId = SESSION) => ({
  payload: {
    response_id: response,
    thread_id: threadId,
    thread_token_usage: { input_tokens: 200, output_tokens: 40 },
    turn_id: turnId,
    turn_token_usage: { input_tokens: 200, output_tokens: 40 },
    usage: {
      cache_write_input_tokens: 0,
      cached_input_tokens: 40,
      input_tokens: 100,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 120,
    },
  },
  timestamp: at(second),
  type: 'token_usage_record',
});

export const withUsage = (
  response: ReturnType<typeof usage>,
  counts: Partial<ReturnType<typeof usage>['payload']['usage']>,
) => ({
  ...response,
  payload: { ...response.payload, usage: { ...response.payload.usage, ...counts } },
});

export const CACHE_WRITE = jsonl([
  meta(),
  turn('write-turn'),
  withUsage(usage('write-response', 'write-turn'), { cache_write_input_tokens: 20 }),
]);

// Hand-calculated final cumulative usage for two requests, not a parser sum.
export const FINAL_USAGE = {
  cached_input_tokens: 80,
  input_tokens: 200,
  output_tokens: 40,
  reasoning_output_tokens: 10,
  total_tokens: 240,
};
export const tokenCount = (second = 3) => ({
  payload: {
    info: {
      last_token_usage: usage('unused', 'unused').payload.usage,
      model_context_window: 258_400,
      total_token_usage: FINAL_USAGE,
    },
    type: 'token_count',
  },
  timestamp: at(second),
  type: 'event_msg',
});
export const turnStarted = (id: string, window = 258_400) => ({
  payload: { model_context_window: window, turn_id: id, type: 'turn_started' },
  timestamp: at(1),
  type: 'event_msg',
});

export const MAIN = jsonl([
  meta(),
  turn('turn-1'),
  turnStarted('turn-1'),
  usage('resp-1', 'turn-1', 4),
  tokenCount(5),
  tokenCount(6),
  turn('turn-2', 'gpt-5.4-mini', 7),
  turnStarted('turn-2'),
  usage('resp-2', 'turn-2', 8),
  usage('resp-2', 'turn-2', 8),
  tokenCount(9),
]);

// The first header belongs to the child. Everything before ordinal 6 is
// inherited, including unmatched records and a copied parent's session_meta.
export const FORK = jsonl([
  {
    ...meta({ id: CHILD }),
    payload: {
      ...meta({ id: CHILD }).payload,
      forked_from_id: SESSION,
      parent_thread_id: SESSION,
      subagent_history_start_ordinal: 6,
    },
  },
  meta(),
  turn('parent-turn'),
  usage('unmatched-replay-1', 'parent-turn'),
  usage('unmatched-replay-2', 'parent-turn'),
  usage('unmatched-replay-3', 'parent-turn'),
  turn('child-turn', 'gpt-5.4-mini'),
  turnStarted('child-turn'),
  usage('child-response', 'child-turn', 0, CHILD),
]);

export const NESTED_FILE = jsonl([
  {
    ...meta({ id: NESTED }),
    payload: { ...meta({ id: NESTED }).payload, parent_thread_id: CHILD },
  },
  turn('nested-turn', 'gpt-5.4-mini'),
  turnStarted('nested-turn'),
  usage('nested-response', 'nested-turn', 3, NESTED),
]);

export const completed = (item: Record<string, unknown>, second = 4) => ({
  payload: { item, thread_id: SESSION, turn_id: 'turn-1', type: 'item_completed' },
  timestamp: at(second),
  type: 'event_msg',
});

export const skillMessage = (role = 'user') => ({
  payload: {
    content: [
      {
        text: '<skill>\n<name>namespace:review</name>\n<path>/mock/skills/review/SKILL.md</path>\nMock instructions\n</skill>',
        type: role === 'user' ? 'input_text' : 'output_text',
      },
    ],
    role,
    type: 'message',
  },
  timestamp: at(5),
  type: 'response_item',
});

export const TOOLS = jsonl([
  meta(),
  turn('turn-1'),
  {
    payload: { call_id: 'exec-wrapper', name: 'exec', type: 'custom_tool_call' },
    timestamp: at(2),
    type: 'response_item',
  },
  completed({
    command: ['cat', '/mock/skills/tdd/SKILL.md'],
    id: 'item-1',
    type: 'CommandExecution',
  }),
  completed({
    command: ['cat', '/mock/skills/tdd/SKILL.md'],
    id: 'item-1',
    type: 'CommandExecution',
  }),
  completed({ id: 'item-2', server: 'docs', tool: 'search', type: 'McpToolCall' }),
  completed({ changes: [], id: 'item-3', type: 'FileChange' }),
  completed({ id: 'item-4', tool: 'spawn_agent', type: 'CollabAgentToolCall' }),
  {
    payload: {
      content: [
        {
          text: '<skill>\n<name>namespace:review</name>\n<path>/mock/skills/review/SKILL.md</path>\nMock instructions\n</skill>',
          type: 'input_text',
        },
      ],
      role: 'user',
      type: 'message',
    },
    timestamp: at(5),
    type: 'response_item',
  },
]);

// Legacy forks carry inherited history but no reliable ordinal boundary.
export const LEGACY_FORK = jsonl([
  {
    ...meta({ id: CHILD }),
    payload: {
      ...meta({ id: CHILD }).payload,
      forked_from_id: SESSION,
      parent_thread_id: SESSION,
    },
  },
  meta(),
  turn('turn-1'),
  usage('resp-1', 'turn-1'),
  completed({
    command: ['cat', '/mock/skills/tdd/SKILL.md'],
    id: 'item-1',
    type: 'CommandExecution',
  }),
  turn('own-turn', 'gpt-5.4-mini'),
  usage('own-response', 'own-turn', 4, CHILD),
]);

export const INTERRUPTED = jsonl([
  meta(),
  turn('interrupted-turn'),
  turnStarted('interrupted-turn'),
  {
    payload: {
      content: [{ text: 'Mock partial response', type: 'output_text' }],
      role: 'assistant',
      type: 'message',
    },
    timestamp: at(2),
    type: 'response_item',
  },
  tokenCount(3),
]);
