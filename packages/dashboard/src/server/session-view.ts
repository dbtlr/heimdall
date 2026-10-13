import type { SQL } from 'bun';

import type { CpuBucket } from './fleet-overview-types.ts';
import { BUCKET_MS, toBucket } from './fleet-overview.ts';
import type { BucketRow } from './fleet-overview.ts';
import type {
  SessionAgent,
  SessionKey,
  SessionRequest,
  SessionStretch,
  SessionToolCall,
  SessionTotals,
  SessionView,
} from './session-view-types.ts';
import type { ProcessSeries } from './system-detail-types.ts';
import { linkOf, toProcesses } from './system-detail.ts';
import type { CoresRow } from './system-detail.ts';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
// The most buckets the Vitals over a Session's span are drawn in.
const MAX_BUCKETS = 90;
// Each divides a day, so a bucket starts on the same grid from any origin at
// midnight UTC, the Hub's and the page's alike.
const WIDTHS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map(
  (minutes) => minutes * MINUTE_MS,
);

const field = (input: unknown, key: string): unknown =>
  typeof input === 'object' && input !== null ? Reflect.get(input, key) : undefined;

const keyPart = (input: unknown, key: keyof SessionKey): string => {
  const part = field(input, key);
  if (typeof part !== 'string' || part === '') {
    throw new Error(`The request names no ${key} for the Session.`);
  }
  return part;
};

// The Session a view request asks for.
export const parseSessionInput = (input: unknown): SessionKey => ({
  harness: keyPart(input, 'harness'),
  sessionId: keyPart(input, 'sessionId'),
  source: keyPart(input, 'source'),
  system: keyPart(input, 'system'),
});

// The width of the Vitals buckets over a Session's span: the smallest of 1, 2,
// 5, 10, 15, and 30 minutes, 1, 2, 3, 6, 12, and 24 hours, then whole days,
// that covers the span in at most 90 buckets.
export const bucketFor = (spanMs: number): number =>
  WIDTHS_MS.find((width) => Math.ceil(spanMs / width) <= MAX_BUCKETS) ??
  Math.ceil(spanMs / MAX_BUCKETS / DAY_MS) * DAY_MS;

// The start of the `widthMs` bucket holding `t`. Buckets align to the epoch, as
// the page's grid does, which is the Hub's 5-minute alignment too.
const bucketAt = (t: number, widthMs: number) => Math.floor(t / widthMs) * widthMs;

type SessionRow = {
  ended_at: Date | null;
  first_cwd: string | null;
  first_git_branch: string | null;
  first_harness_version: string | null;
  last_cwd: string | null;
  last_git_branch: string | null;
  last_harness_version: string | null;
  started_at: Date | null;
};

type AgentRow = {
  agent_id: string;
  agent_type: string | null;
  depth: number | null;
  ended_at: Date | null;
  parent_agent_id: string | null;
  started_at: Date | null;
  workflow_phase: string | null;
  workflow_run: string | null;
};

type RequestRow = {
  agent_id: string | null;
  at: Date;
  cache_read_cost_usd: number | null;
  cache_read_tokens: number;
  cache_write_cost_usd: number | null;
  cache_write_tokens: number;
  context_tokens: number;
  context_window: number | null;
  cost_usd: number | null;
  input_cost_usd: number | null;
  input_tokens: number;
  model: string;
  output_cost_usd: number | null;
  output_tokens: number;
  request_id: string;
  skill: string | null;
  stop_reason: string | null;
};

type ToolCallRow = {
  agent_id: string | null;
  at: Date;
  call_id: string;
  kind: string;
  mcp_server: string | null;
  name: string;
  request_id: string | null;
};

type StretchRow = {
  candidates: number;
  ended_at: Date;
  link: string;
  pid: number | null;
  process_id: number | null;
  requests: number;
  started_at: Date;
};

type TotalsRow = {
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  priced_cost_usd: number | null;
  requests: number;
  unpriced_requests: number;
};

const optional = <T>(value: T | null): T | undefined => value ?? undefined;

const toAgent = (row: AgentRow, span: { endedAt: number; startedAt: number }): SessionAgent => ({
  agentId: row.agent_id,
  agentType: optional(row.agent_type),
  // Codex does not know a subagent's depth until it links it to its parent.
  depth: row.depth ?? 1,
  endedAt: row.ended_at?.getTime() ?? span.endedAt,
  parentAgentId: optional(row.parent_agent_id),
  startedAt: row.started_at?.getTime() ?? span.startedAt,
  workflowPhase: optional(row.workflow_phase),
  workflowRun: optional(row.workflow_run),
});

const toRequest = (row: RequestRow): SessionRequest => ({
  agentId: optional(row.agent_id),
  at: row.at.getTime(),
  cacheReadCostUsd: optional(row.cache_read_cost_usd),
  cacheReadTokens: row.cache_read_tokens,
  cacheWriteCostUsd: optional(row.cache_write_cost_usd),
  cacheWriteTokens: row.cache_write_tokens,
  contextTokens: row.context_tokens,
  contextWindow: optional(row.context_window),
  costUsd: optional(row.cost_usd),
  inputCostUsd: optional(row.input_cost_usd),
  inputTokens: row.input_tokens,
  interrupted: row.stop_reason === null,
  model: row.model,
  outputCostUsd: optional(row.output_cost_usd),
  outputTokens: row.output_tokens,
  requestId: row.request_id,
  skill: optional(row.skill),
  stopReason: optional(row.stop_reason),
});

const toToolCall = (row: ToolCallRow): SessionToolCall => {
  if (row.kind !== 'tool' && row.kind !== 'command') {
    throw new Error(
      `The Hub holds a tool call of kind ${row.kind}, which the dashboard does not know.`,
    );
  }
  return {
    agentId: optional(row.agent_id),
    at: row.at.getTime(),
    callId: row.call_id,
    kind: row.kind,
    mcpServer: optional(row.mcp_server),
    name: row.name,
    requestId: optional(row.request_id),
  };
};

const toStretch = (row: StretchRow): SessionStretch => ({
  candidates: row.candidates,
  endedAt: row.ended_at.getTime(),
  link: linkOf(row.link),
  pid: optional(row.pid),
  processId: optional(row.process_id),
  requests: row.requests,
  startedAt: row.started_at.getTime(),
});

const toTotals = (row: TotalsRow | undefined, mainRequests: number): SessionTotals => ({
  cacheReadTokens: row?.cache_read_tokens ?? 0,
  cacheWriteTokens: row?.cache_write_tokens ?? 0,
  costUsd: optional(row?.cost_usd ?? null),
  inputTokens: row?.input_tokens ?? 0,
  mainRequests,
  outputTokens: row?.output_tokens ?? 0,
  pricedCostUsd: row?.priced_cost_usd ?? 0,
  requests: row?.requests ?? 0,
  unpricedRequests: row?.unpriced_requests ?? 0,
});

// The Session's span: the earliest and latest of its own bounds, its requests,
// and its subagents, so a subagent that worked past the main transcript is
// inside it. Undefined for a Session with no time at all.
const spanOf = (
  session: SessionRow,
  times: readonly (Date | null)[],
): { endedAt: number; startedAt: number } | undefined => {
  const all = [session.started_at, session.ended_at, ...times].flatMap((t) =>
    t === null ? [] : [t.getTime()],
  );
  return all.length === 0 ? undefined : { endedAt: Math.max(...all), startedAt: Math.min(...all) };
};

// Whether System `system` still holds raw Vitals samples back to the bucket
// that holds `from`. Samples are pruned from the oldest, so a Session that
// starts before the oldest one reads rollups for all of it.
const hasRawFrom = async (sql: SQL, system: string, from: number, widthMs: number) => {
  const [oldest]: { t: Date | null }[] = await sql`
    SELECT min(t) AS t FROM vitals_samples WHERE system = ${system}
  `;
  return oldest?.t != null && oldest.t.getTime() <= bucketAt(from, widthMs);
};

// System `system`'s CPU busy over [from, to] in `widthMs` buckets from its raw
// samples, or, when those no longer reach back to `from`, from its 5-minute
// rollups binned to `widthMs` where that is wider. Answers the width the
// buckets have, and whether they came from raw samples.
const readCpu = async (
  sql: SQL,
  { from, system, to, widthMs }: { from: number; system: string; to: number; widthMs: number },
): Promise<{ bucketMs: number; cpu: CpuBucket[]; raw: boolean }> => {
  const toAt = new Date(to);
  if (await hasRawFrom(sql, system, from, widthMs)) {
    const rows: BucketRow[] = await sql`
      SELECT system, date_bin(make_interval(secs => ${widthMs / 1000}), t,
                              timestamptz '1970-01-01 00:00:00+00') AS bucket,
             count(*)::int AS samples, min(cpu_busy_percent) AS cpu_busy_min,
             sum(cpu_busy_percent) AS cpu_busy_sum, max(cpu_busy_percent) AS cpu_busy_max
      FROM vitals_samples
      WHERE system = ${system} AND t >= ${new Date(bucketAt(from, widthMs))} AND t <= ${toAt}
      GROUP BY system, 2
      ORDER BY 2
    `;
    return { bucketMs: widthMs, cpu: rows.map(toBucket), raw: true };
  }
  const bucketMs = Math.max(BUCKET_MS, widthMs);
  const rows: BucketRow[] = await sql`
    SELECT system, date_bin(make_interval(secs => ${bucketMs / 1000}), bucket,
                            timestamptz '1970-01-01 00:00:00+00') AS bucket,
           sum(samples)::int AS samples, min(cpu_busy_min) AS cpu_busy_min,
           sum(cpu_busy_sum) AS cpu_busy_sum, max(cpu_busy_max) AS cpu_busy_max
    FROM vitals_rollups
    WHERE system = ${system} AND bucket >= ${new Date(bucketAt(from, bucketMs))}
      AND bucket <= ${toAt}
    GROUP BY system, 2
    ORDER BY 2
  `;
  return { bucketMs, cpu: rows.map(toBucket), raw: false };
};

// The cores of Harness process `processId` over [from, to] in `widthMs`
// buckets: from its raw readings when the Vitals came from raw samples, as the
// System detail computes them, else from its 5-minute rollups binned to
// `widthMs`. Rollups keep no reading times, so a bucket's cores are the CPU
// time it saw over its whole width. A process whose readings are gone while
// the Vitals' are not reads its rollups too, unless the buckets are narrower
// than 5 minutes, which its rollups cannot line up with.
const readCores = async (
  sql: SQL,
  {
    from,
    processId,
    raw,
    to,
    widthMs,
  }: { from: number; processId: number; raw: boolean; to: number; widthMs: number },
): Promise<CoresRow[]> => {
  const toAt = new Date(to);
  if (raw) {
    const rows: CoresRow[] = await sql`
      SELECT p.id::float8 AS process_id, p.harness, p.pid, p.cwd, r.bucket,
             CASE WHEN r.last_t > r.first_t
                  THEN ((r.cpu_max - r.cpu_min) / 1e6 / extract(epoch FROM r.last_t - r.first_t))::float8
             END AS cores
      FROM harness_processes p
      CROSS JOIN LATERAL (
        SELECT date_bin(make_interval(secs => ${widthMs / 1000}), x.t,
                        timestamptz '1970-01-01 00:00:00+00') AS bucket,
               min(x.t) AS first_t, max(x.t) AS last_t,
               min(x.cpu_micros) AS cpu_min, max(x.cpu_micros) AS cpu_max
        FROM harness_process_samples x
        WHERE x.process = p.id AND x.t >= ${new Date(bucketAt(from, widthMs))} AND x.t <= ${toAt}
        GROUP BY 1
      ) r
      WHERE p.id = ${processId}
      ORDER BY r.bucket
    `;
    if (rows.length > 0 || widthMs < BUCKET_MS) {
      return rows;
    }
  }
  const binMs = Math.max(BUCKET_MS, widthMs);
  return sql`
    SELECT p.id::float8 AS process_id, p.harness, p.pid, p.cwd,
           date_bin(make_interval(secs => ${binMs / 1000}), r.bucket,
                    timestamptz '1970-01-01 00:00:00+00') AS bucket,
           ((max(r.cpu_micros_max) - min(r.cpu_micros_min)) / 1e6 / ${binMs / 1000})::float8 AS cores
    FROM harness_processes p
    JOIN harness_process_rollups r ON r.process = p.id
    WHERE p.id = ${processId} AND r.bucket >= ${new Date(bucketAt(from, binMs))}
      AND r.bucket <= ${toAt}
    GROUP BY p.id, p.harness, p.pid, p.cwd, 5
    ORDER BY 5
  `;
};

// The cores of each process a stretch is linked to, in order of first stretch.
const readProcesses = async (
  sql: SQL,
  stretches: readonly SessionStretch[],
  span: { from: number; raw: boolean; to: number; widthMs: number },
): Promise<ProcessSeries[]> => {
  const ids = [
    ...new Set(stretches.flatMap(({ processId }) => (processId === undefined ? [] : [processId]))),
  ];
  const rows = await Promise.all(ids.map((processId) => readCores(sql, { ...span, processId })));
  return toProcesses(rows.flat());
};

// One agent Session as its requests, subagents, tool calls, and stretches, with
// the Vitals of its System and the cores of the processes it ran on over its
// span. Undefined for a Session the Hub does not hold. Every query looks the
// Session up by its key, and reads no transcript content. Read-only.
export const readSessionView = async (
  sql: SQL,
  { harness, sessionId, source, system, timeZone }: SessionKey & { timeZone: string },
): Promise<SessionView | undefined> => {
  const [sessions, agents, requests, toolCalls, stretches, totals, main]: [
    SessionRow[],
    AgentRow[],
    RequestRow[],
    ToolCallRow[],
    StretchRow[],
    TotalsRow[],
    { requests: number }[],
  ] = await Promise.all([
    sql`
      SELECT started_at, ended_at, first_cwd, last_cwd, first_git_branch, last_git_branch,
             first_harness_version, last_harness_version
      FROM insight.sessions
      WHERE harness = ${harness} AND system = ${system} AND source = ${source}
        AND session_id = ${sessionId}
    `,
    sql`
      SELECT agent_id, parent_agent_id, agent_type, depth, workflow_run, workflow_phase,
             started_at, ended_at
      FROM insight.subagents
      WHERE harness = ${harness} AND system = ${system} AND source = ${source}
        AND session_id = ${sessionId}
      ORDER BY started_at, agent_id
    `,
    sql`
      SELECT agent_id, request_id, at, model, input_tokens::float8 AS input_tokens,
             output_tokens::float8 AS output_tokens, cache_read_tokens::float8 AS cache_read_tokens,
             cache_write_tokens::float8 AS cache_write_tokens,
             context_tokens::float8 AS context_tokens, context_window::float8 AS context_window,
             stop_reason, skill, cost_usd::float8 AS cost_usd,
             input_cost_usd::float8 AS input_cost_usd, output_cost_usd::float8 AS output_cost_usd,
             cache_read_cost_usd::float8 AS cache_read_cost_usd,
             cache_write_cost_usd::float8 AS cache_write_cost_usd
      FROM insight.requests
      WHERE harness = ${harness} AND system = ${system} AND source = ${source}
        AND session_id = ${sessionId}
      ORDER BY at, request_id
    `,
    sql`
      SELECT agent_id, request_id, call_id, at, kind, name, mcp_server
      FROM insight.tool_calls
      WHERE harness = ${harness} AND system = ${system} AND source = ${source}
        AND session_id = ${sessionId}
      ORDER BY at, call_id
    `,
    sql`
      SELECT started_at, ended_at, requests::int AS requests, link, process_id::float8 AS process_id,
             pid, candidates::int AS candidates
      FROM insight.session_stretches
      WHERE harness = ${harness} AND system = ${system} AND source = ${source}
        AND session_id = ${sessionId}
      ORDER BY started_at
    `,
    sql`
      SELECT requests::int AS requests, input_tokens::float8 AS input_tokens,
             output_tokens::float8 AS output_tokens, cache_read_tokens::float8 AS cache_read_tokens,
             cache_write_tokens::float8 AS cache_write_tokens, cost_usd::float8 AS cost_usd,
             priced_cost_usd::float8 AS priced_cost_usd, unpriced_requests::int AS unpriced_requests
      FROM insight.session_totals
      WHERE harness = ${harness} AND system = ${system} AND source = ${source}
        AND session_id = ${sessionId}
    `,
    sql`
      SELECT requests::int AS requests
      FROM insight.main_conversation_totals
      WHERE harness = ${harness} AND system = ${system} AND source = ${source}
        AND session_id = ${sessionId}
    `,
  ]);
  const session = sessions[0];
  if (session === undefined) {
    return undefined;
  }
  const span = spanOf(session, [
    ...requests.map(({ at }) => at),
    ...agents.flatMap((row) => [row.started_at, row.ended_at]),
  ]);
  if (span === undefined) {
    return undefined;
  }
  const widthMs = bucketFor(span.endedAt - span.startedAt);
  const { bucketMs, cpu, raw } = await readCpu(sql, {
    from: span.startedAt,
    system,
    to: span.endedAt,
    widthMs,
  });
  const linked = stretches.map(toStretch);
  return {
    agents: agents.map((row) => toAgent(row, span)),
    branch: optional(session.last_git_branch ?? session.first_git_branch),
    bucketMs,
    cpu,
    cwd: optional(session.last_cwd ?? session.first_cwd),
    endedAt: span.endedAt,
    harness,
    harnessVersion: optional(session.last_harness_version ?? session.first_harness_version),
    processes: await readProcesses(sql, linked, {
      from: span.startedAt,
      raw,
      to: span.endedAt,
      widthMs: bucketMs,
    }),
    requests: requests.map(toRequest),
    sessionId,
    source,
    startedAt: span.startedAt,
    stretches: linked,
    system,
    timeZone,
    toolCalls: toolCalls.map(toToolCall),
    totals: toTotals(totals[0], main[0]?.requests ?? 0),
  };
};
