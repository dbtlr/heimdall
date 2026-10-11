// Synthetic Claude Code transcript lines for tests. They reproduce the shapes
// Claude Code writes, with made-up ids and no real content: one line per
// content block, each repeating its response's usage under `message.id`.

export const SESSION = '0b1c2d3e-0000-4000-8000-000000000001';
export const PROJECT = '-home-someone-work-my-project';

// The path of a main conversation's transcript within a Claude Code source.
export const mainPath = (session = SESSION) => `projects/${PROJECT}/${session}.jsonl`;

// The path of a subagent's transcript, or its `.meta.json` with `meta`, and,
// under `workflow`, of a workflow agent's.
export const agentPath = (
  agent: string,
  {
    meta = false,
    session = SESSION,
    workflow,
  }: { meta?: boolean; session?: string; workflow?: string } = {},
) =>
  `projects/${PROJECT}/${session}/subagents/${workflow === undefined ? '' : `workflows/${workflow}/`}agent-${agent}.${meta ? 'meta.json' : 'jsonl'}`;

export type Usage = {
  cacheRead?: number;
  cacheWrite1h?: number;
  cacheWrite5m?: number;
  input?: number;
  output?: number;
  thinking?: number;
};

type Context = {
  agent?: string;
  at: string;
  branch?: string;
  cwd?: string;
  session?: string;
  version?: string;
};

const envelope = ({
  agent,
  at,
  branch = 'main',
  cwd = '/home/someone/work/my-project',
  session = SESSION,
  version = '2.1.290',
}: Context) => ({
  ...(agent === undefined ? {} : { agentId: agent }),
  cwd,
  gitBranch: branch,
  isSidechain: agent !== undefined,
  sessionId: session,
  timestamp: at,
  userType: 'external',
  version,
});

const usageOf = ({
  cacheRead = 0,
  cacheWrite1h = 0,
  cacheWrite5m = 0,
  input = 0,
  output = 0,
  thinking,
}: Usage) => ({
  cache_creation: {
    ephemeral_1h_input_tokens: cacheWrite1h,
    ephemeral_5m_input_tokens: cacheWrite5m,
  },
  cache_creation_input_tokens: cacheWrite5m + cacheWrite1h,
  cache_read_input_tokens: cacheRead,
  input_tokens: input,
  output_tokens: output,
  ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
  service_tier: 'standard',
});

export type Block =
  | { kind: 'text' }
  | { kind: 'thinking' }
  | { id: string; input?: Record<string, unknown>; kind: 'tool'; name: string };

const contentOf = (block: Block) => {
  switch (block.kind) {
    case 'text': {
      return { text: 'Synthetic reply.', type: 'text' };
    }
    case 'thinking': {
      return { signature: 'c2ln', thinking: 'Synthetic thought.', type: 'thinking' };
    }
    case 'tool': {
      return { id: block.id, input: block.input ?? {}, name: block.name, type: 'tool_use' };
    }
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
};

// One assistant line: one content block of response `id`, with the
// response's usage as Claude Code repeats it on every line.
export const assistant = ({
  block = { kind: 'text' },
  id,
  model = 'claude-sonnet-5-5',
  skill,
  stop = 'end_turn',
  usage = {},
  ...context
}: Context & {
  block?: Block;
  id: string;
  model?: string;
  skill?: string;
  stop?: string | null;
  usage?: Usage;
}) => ({
  ...envelope(context),
  ...(skill === undefined ? {} : { attributionSkill: skill }),
  message: {
    content: [contentOf(block)],
    id,
    model,
    role: 'assistant',
    stop_reason: stop,
    type: 'message',
    usage: usageOf(usage),
  },
  requestId: `req_${id}`,
  type: 'assistant',
  uuid: crypto.randomUUID(),
});

// One user line: a prompt, or a slash command such as `/review` when `command` is given.
export const user = ({
  command,
  uuid = crypto.randomUUID(),
  ...context
}: Context & { command?: string; uuid?: string }) => ({
  ...envelope(context),
  message: {
    content:
      command === undefined
        ? 'Synthetic prompt.'
        : `<command-message>${command.slice(1)}</command-message>\n<command-name>${command}</command-name>`,
    role: 'user',
  },
  type: 'user',
  uuid,
});

// An attachment line listing the skills a Session may use, which invokes none.
export const skillListing = (context: Context) => ({
  ...envelope(context),
  attachment: { content: '- tdd: Synthetic skill.', type: 'skill_listing' },
  type: 'attachment',
  uuid: crypto.randomUUID(),
});

export type ModelUsage = {
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  inputTokens: number;
  outputTokens: number;
};

// Claude Code's own running total for a Session, which it appends to the main
// transcript as it goes. Tests reconcile the projection against it.
export const costState = ({
  models,
  session = SESSION,
}: {
  models: Record<string, ModelUsage>;
  session?: string;
}) => ({
  modelUsage: Object.fromEntries(
    Object.entries(models).map(([model, usage]) => [
      model,
      { ...usage, costUSD: 0, thinkingTokens: 0, webSearchRequests: 0 },
    ]),
  ),
  sessionId: session,
  startTime: 1_790_000_000_000,
  totalCostUSD: 0,
  type: 'cost-state',
});

// A subagent's `.meta.json`: spawned by the parent's tool call `toolUseId`, or
// by a workflow's `workflowPhase`.
export const agentMeta = (
  meta: { agentType: string; spawnDepth?: number } & (
    | { toolUseId: string }
    | { workflowPhase: string }
  ),
) => JSON.stringify({ description: 'Synthetic task.', model: 'inherit', spawnDepth: 1, ...meta });

// Lines as Claude Code writes them: one JSON object per line, each ending in a newline.
export const jsonl = (lines: readonly unknown[]) =>
  lines.map((line) => `${JSON.stringify(line)}\n`).join('');
