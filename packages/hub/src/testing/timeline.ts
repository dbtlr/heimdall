import type { SQL } from 'bun';

// The working directory of a fixture Session or process unless it names another.
export const CWD = '/home/someone/work/my-project';

// One request of a fixture Session, when its time alone is not enough.
export type RequestFixture = {
  agentId?: string;
  // Seconds.
  at: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputTokens?: number;
  model?: string;
  outputTokens?: number;
  skill?: string;
  // Null, the default, is an interrupted response.
  stopReason?: string | null;
};

// A request's time in seconds, or the request with its own detail.
type RequestEntry = number | RequestFixture;

const detail = (entry: RequestEntry): RequestFixture =>
  typeof entry === 'number' ? { at: entry } : entry;

export type SubagentFixture = {
  agentId: string;
  agentType?: string;
  depth?: number;
  parentAgentId?: string;
  // The subagent's span runs from its first request to its last.
  requests: RequestEntry[];
  workflowPhase?: string;
  workflowRun?: string;
};

export type ToolCallFixture = {
  // Whose request the call is in: the main conversation unless it names a subagent.
  agentId?: string;
  // Seconds.
  at: number;
  kind?: 'command' | 'tool';
  mcpServer?: string;
  name: string;
  // The index of the request among its agent's requests that made the call.
  requestIndex?: number;
};

export type SessionFixture = {
  firstCwd?: string;
  gitBranch?: string;
  harness?: string;
  harnessVersion?: string;
  id: string;
  inputTokens?: number;
  lastCwd?: string;
  model?: string;
  outputTokens?: number;
  // The times of its requests, in seconds, or the requests with their detail;
  // its span runs from the first to the last.
  requests: RequestEntry[];
  // Defaults to the Harness.
  source?: string;
  // The times of its subagent's requests; the subagent, with id a1, spans the first to the last.
  subagentRequests?: number[];
  subagents?: SubagentFixture[];
  system?: string;
  toolCalls?: ToolCallFixture[];
};

export type ProcessFixture = {
  // The CPU cores the process tree keeps busy, steadily from its start.
  cpuCores?: number;
  cwd?: string | null;
  // Seconds. A seen end, or with `endMissed` the last sighting; undefined while running.
  end?: number;
  endMissed?: boolean;
  harness?: string;
  pid: number;
  // Readings are every 15 seconds from `seenFrom` and at `seenTo`, the last
  // sighting; they default to the process's life, or 100,000 s while running.
  // The Hub keeps them as samples, as 5-minute rollups, or both; rollups alone
  // are what is left after samples are pruned.
  readings?: 'both' | 'rollups' | 'samples';
  rssBytes?: number;
  seenFrom?: number;
  seenTo?: number;
  start: number;
  system?: string;
};

export type ConditionFixture = {
  // Seconds; undefined while the Condition is open.
  clearedAt?: number;
  kind: string;
  raisedAt: number;
  reason?: string;
  subject?: string;
  system: string;
};

// Seeds the rows the Hub derives or receives, so a test or a dev seed need not
// go through a Collector and a parser for each one. Every time is in seconds
// after `origin` (epoch milliseconds), so a fixture reads as a timeline. The
// Systems named must exist: send a Report for each first.
export const timeline = (origin: number) => {
  const at = (seconds: number) => new Date(origin + seconds * 1000);

  // Adds a Session whose main transcript spans its requests, and the requests,
  // and its subagents' and tool calls when it has them. Its Harness gets a
  // current parser.
  const addSession = async (
    sql: SQL,
    {
      firstCwd = CWD,
      gitBranch,
      harness = 'claude-code',
      harnessVersion,
      id,
      inputTokens = 1,
      lastCwd,
      model = 'claude-opus-4-1',
      outputTokens = 2,
      requests,
      source = harness,
      subagentRequests = [],
      subagents = [],
      system = 'laptop-1',
      toolCalls = [],
    }: SessionFixture,
  ) => {
    const path = `projects/p/${id}.jsonl`;
    const agents: SubagentFixture[] = [
      ...(subagentRequests.length === 0 ? [] : [{ agentId: 'a1', requests: subagentRequests }]),
      ...subagents,
    ];
    const mainRequests = requests.map(detail);
    // The main conversation's requests, then each subagent's.
    const requestsOf = [
      { agent: undefined, entries: mainRequests },
      ...agents.map((agent) => ({ agent, entries: agent.requests.map(detail) })),
    ];
    await sql`
      INSERT INTO current_parsers (harness, version) VALUES (${harness}, 1)
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO projected_sessions (
        harness, parser_version, system, source, session_id, path, started_at, ended_at,
        first_cwd, last_cwd, first_git_branch, last_git_branch, first_harness_version,
        last_harness_version
      )
      VALUES (${harness}, 1, ${system}, ${source}, ${id}, ${path},
              ${at(Math.min(...mainRequests.map((r) => r.at)))},
              ${at(Math.max(...mainRequests.map((r) => r.at)))}, ${firstCwd},
              ${lastCwd ?? firstCwd}, ${gitBranch ?? null}, ${gitBranch ?? null},
              ${harnessVersion ?? null}, ${harnessVersion ?? null})
    `;
    const [row]: { id: string }[] = await sql`
      INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
      SELECT coalesce(max(id), 0) + 1, ${system}, ${source}, ${path}, now(), now()
      FROM transcript_generations
      RETURNING id
    `;
    const generation = Number(row?.id);
    const requestId = (agentId: string | undefined, index: number) =>
      agentId === undefined ? `${id}-${String(index)}` : `${id}-${agentId}-${String(index)}`;
    for (const [agentIndex, { agent, entries }] of requestsOf.entries()) {
      if (agent !== undefined) {
        const times = entries.map((entry) => entry.at);
        // oxlint-disable-next-line no-await-in-loop -- a handful of fixture rows.
        await sql`
          INSERT INTO projected_subagents (
            harness, parser_version, system, source, session_id, agent_id, agent_type, depth,
            parent_agent_id, workflow_run, workflow_phase, started_at, ended_at
          )
          VALUES (${harness}, 1, ${system}, ${source}, ${id}, ${agent.agentId},
                  ${agent.agentType ?? null}, ${agent.depth ?? null},
                  ${agent.parentAgentId ?? null}, ${agent.workflowRun ?? null},
                  ${agent.workflowPhase ?? null}, ${at(Math.min(...times))},
                  ${at(Math.max(...times))})
        `;
      }
      for (const [index, entry] of entries.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- a handful of fixture rows.
        await sql`
          INSERT INTO projected_requests (
            harness, parser_version, system, source, session_id, agent_id, request_id, at, model,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, stop_reason,
            skill, generation, byte_offset
          )
          VALUES (${harness}, 1, ${system}, ${source}, ${id},
                  ${agent?.agentId ?? entry.agentId ?? null},
                  ${requestId(agent?.agentId, index)}, ${at(entry.at)}, ${entry.model ?? model},
                  ${entry.inputTokens ?? inputTokens}, ${entry.outputTokens ?? outputTokens},
                  ${entry.cacheReadTokens ?? 0}, ${entry.cacheWriteTokens ?? 0},
                  ${entry.stopReason ?? null}, ${entry.skill ?? null}, ${generation},
                  ${1000 * agentIndex + index})
        `;
      }
    }
    for (const [index, call] of toolCalls.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of fixture rows.
      await sql`
        INSERT INTO projected_tool_calls (
          harness, parser_version, system, source, session_id, agent_id, call_id, request_id, at,
          kind, name, mcp_server, generation, byte_offset
        )
        VALUES (${harness}, 1, ${system}, ${source}, ${id}, ${call.agentId ?? null},
                ${`${id}-call-${String(index)}`},
                ${call.requestIndex === undefined ? null : requestId(call.agentId, call.requestIndex)},
                ${at(call.at)}, ${call.kind ?? 'tool'}, ${call.name}, ${call.mcpServer ?? null},
                ${generation}, ${100_000 + index})
      `;
    }
  };

  // Adds a Harness process as the Hub holds it, with its readings, and answers
  // its id. A missed end is stored as the Hub stores one: at the last sighting.
  const addProcess = async (
    sql: SQL,
    {
      cpuCores = 0,
      cwd = CWD,
      end,
      endMissed = false,
      harness = 'claude-code',
      pid,
      readings = 'samples',
      rssBytes = 0,
      seenFrom,
      seenTo,
      start,
      system = 'laptop-1',
    }: ProcessFixture,
  ): Promise<number> => {
    const from = seenFrom ?? start;
    const to = seenTo ?? end ?? 100_000;
    const [row]: { id: string }[] = await sql`
      INSERT INTO harness_processes (
        system, harness, pid, started_at, ended_at, end_missed, cwd, peak_rss_bytes,
        last_seen_at, sent_at
      )
      VALUES (${system}, ${harness}, ${pid}, ${at(start)}, ${end === undefined ? null : at(end)},
              ${endMissed}, ${cwd}, ${rssBytes}, ${at(to)}, ${at(to)})
      RETURNING id
    `;
    const id = Number(row?.id);
    await sql`
      INSERT INTO harness_process_samples (process, t, cpu_micros, rss_bytes)
      SELECT ${id}, ${at(0)}::timestamptz + s * interval '1 second',
             round((s - ${start}) * ${cpuCores} * 1e6), ${rssBytes}
      FROM (SELECT generate_series(${from}::numeric, ${to}::numeric, 15) UNION SELECT ${to}::numeric) AS g (s)
    `;
    if (readings !== 'samples') {
      await sql`
        INSERT INTO harness_process_rollups
          (process, bucket, samples, cpu_micros_min, cpu_micros_max, rss_min, rss_sum, rss_max)
        SELECT process, date_bin('5 minutes', t, timestamptz '2000-01-01 00:00:00+00'), count(*),
               min(cpu_micros), max(cpu_micros), min(rss_bytes), sum(rss_bytes), max(rss_bytes)
        FROM harness_process_samples WHERE process = ${id} GROUP BY 1, 2
      `;
    }
    if (readings === 'rollups') {
      await sql`DELETE FROM harness_process_samples WHERE process = ${id}`;
    }
    return id;
  };

  // Adds a Vitals sample at `t` and folds it into its 5-minute rollup, as the
  // Hub's ingest does for the Vitals a test reads back.
  const addVitals = async (sql: SQL, system: string, t: number, cpuBusyPercent = 10) => {
    await sql`
      INSERT INTO vitals_samples (
        system, t, cpu_busy_percent, memory_total_bytes, memory_used_bytes, load_1, load_5,
        load_15, uptime_seconds, disks, collector_cpu_percent, collector_rss_bytes
      )
      VALUES (${system}, ${at(t)}, ${cpuBusyPercent}, 1000, 500, 1, 1, 1, 100, '[]', 0, 0)
    `;
    await sql`
      INSERT INTO vitals_rollups AS r (
        system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max, memory_used_min,
        memory_used_sum, memory_used_max, memory_total_max, load_1_min, load_1_sum, load_1_max,
        uptime_min, collector_cpu_sum, collector_cpu_max, collector_rss_sum, collector_rss_max
      )
      VALUES (${system}, date_bin('5 minutes', ${at(t)}::timestamptz, timestamptz '2000-01-01 00:00:00+00'),
              1, ${cpuBusyPercent}, ${cpuBusyPercent}, ${cpuBusyPercent}, 500, 500, 500, 1000,
              1, 1, 1, 100, 0, 0, 0, 0)
      ON CONFLICT (system, bucket) DO UPDATE SET
        samples = r.samples + 1,
        cpu_busy_min = LEAST(r.cpu_busy_min, excluded.cpu_busy_min),
        cpu_busy_sum = r.cpu_busy_sum + excluded.cpu_busy_sum,
        cpu_busy_max = GREATEST(r.cpu_busy_max, excluded.cpu_busy_max)
    `;
  };

  // Adds a Condition as the Hub stores one: open unless `clearedAt` is given.
  const addCondition = async (
    sql: SQL,
    { clearedAt, kind, raisedAt, reason = kind, subject = '', system }: ConditionFixture,
  ) => {
    await sql`
      INSERT INTO conditions (
        system, kind, subject, raised_at, raised_reason, latest_at, latest_reason, cleared_at
      )
      VALUES (${system}, ${kind}, ${subject}, ${at(raisedAt)}, ${reason}, ${at(raisedAt)},
              ${reason}, ${clearedAt === undefined ? null : at(clearedAt)})
    `;
  };

  return { addCondition, addProcess, addSession, addVitals, at };
};
