import type { SQL } from 'bun';

// The working directory of a fixture Session or process unless it names another.
export const CWD = '/home/someone/work/my-project';

export type SessionFixture = {
  firstCwd?: string;
  gitBranch?: string;
  harness?: string;
  id: string;
  inputTokens?: number;
  lastCwd?: string;
  model?: string;
  outputTokens?: number;
  // The times of its requests, in seconds; its span runs from the first to the last.
  requests: number[];
  // The times of its subagent's requests; the subagent's span runs from the first to the last.
  subagentRequests?: number[];
  system?: string;
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
  // and a subagent's when it has one. Its Harness gets a current parser.
  const addSession = async (
    sql: SQL,
    {
      firstCwd = CWD,
      gitBranch,
      harness = 'claude-code',
      id,
      inputTokens = 1,
      lastCwd,
      model = 'claude-opus-4-1',
      outputTokens = 2,
      requests,
      subagentRequests = [],
      system = 'laptop-1',
    }: SessionFixture,
  ) => {
    const source = harness;
    const path = `projects/p/${id}.jsonl`;
    await sql`
      INSERT INTO current_parsers (harness, version) VALUES (${harness}, 1)
      ON CONFLICT DO NOTHING
    `;
    await sql`
      INSERT INTO projected_sessions (
        harness, parser_version, system, source, session_id, path, started_at, ended_at,
        first_cwd, last_cwd, first_git_branch, last_git_branch
      )
      VALUES (${harness}, 1, ${system}, ${source}, ${id}, ${path},
              ${at(Math.min(...requests))}, ${at(Math.max(...requests))}, ${firstCwd},
              ${lastCwd ?? firstCwd}, ${gitBranch ?? null}, ${gitBranch ?? null})
    `;
    const [row]: { id: string }[] = await sql`
      INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
      SELECT coalesce(max(id), 0) + 1, ${system}, ${source}, ${path}, now(), now()
      FROM transcript_generations
      RETURNING id
    `;
    const generation = Number(row?.id);
    for (const [index, seconds] of requests.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of fixture rows.
      await sql`
        INSERT INTO projected_requests (
          harness, parser_version, system, source, session_id, request_id, at, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, generation,
          byte_offset
        )
        VALUES (${harness}, 1, ${system}, ${source}, ${id}, ${`${id}-${String(index)}`},
                ${at(seconds)}, ${model}, ${inputTokens}, ${outputTokens}, 0, 0, ${generation},
                ${index})
      `;
    }
    if (subagentRequests.length === 0) {
      return;
    }
    await sql`
      INSERT INTO projected_subagents (
        harness, parser_version, system, source, session_id, agent_id, started_at, ended_at
      )
      VALUES (${harness}, 1, ${system}, ${source}, ${id}, 'a1',
              ${at(Math.min(...subagentRequests))}, ${at(Math.max(...subagentRequests))})
    `;
    for (const [index, seconds] of subagentRequests.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of fixture rows.
      await sql`
        INSERT INTO projected_requests (
          harness, parser_version, system, source, session_id, agent_id, request_id, at, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, generation,
          byte_offset
        )
        VALUES (${harness}, 1, ${system}, ${source}, ${id}, 'a1',
                ${`${id}-a1-${String(index)}`}, ${at(seconds)}, ${model}, ${inputTokens},
                ${outputTokens}, 0, 0, ${generation}, ${1000 + index})
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
