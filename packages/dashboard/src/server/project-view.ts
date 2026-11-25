import { notFound } from '@tanstack/react-router';
import type { SQL } from 'bun';

import { RUNNING_MS } from '../lib/home-agents.ts';
import { unionMs } from '../lib/project-activity.ts';
import type { AgentsRange, AgentsSession } from './agents-overview-types.ts';
import { agentsPeriod, readPeriodOverview } from './agents-overview.ts';
import { projectNameSql, sessionProjectSql } from './project-sql.ts';
import { readRoleSplit } from './role-split.ts';
import { sessionSpans } from './session-spans.ts';
import { readSnapshot, settleAll, settleBoth } from './snapshot.ts';

// One stretch of a Session's request activity on the dossier's lanes.
export type ActivityLane = {
  system: string;
  harness: string;
  source: string;
  sessionId: string;
  start: number;
  end: number;
};
type Count = { name: string; sessions: number };
export type ToolCount = {
  name: string;
  kind: string;
  mcpServer: string | null;
  skill: string | null;
  calls: number;
};

// The most tool, MCP tool, and skill names a dossier lists, the most called first.
export const TOOLS_LISTED = 30;

// The dossier's Sessions table is a short tail of the period's newest.
export const SESSIONS_TAIL = 5;

type Key = {
  harness: string;
  system: string;
  source: string;
  session_id: string;
};
const keyOf = (row: Pick<AgentsSession, 'harness' | 'sessionId' | 'source' | 'system'>) =>
  JSON.stringify([row.system, row.harness, row.source, row.sessionId]);
const rowKey = (row: Key) => JSON.stringify([row.system, row.harness, row.source, row.session_id]);

// A dossier reads one snapshot. As on the Agents page, the 30-day read
// borrows a second connection on that snapshot for the project's activity,
// which runs beside the header and the cost overview: at production scale
// (9,000 Sessions in the period) the reads take about 0.7 s on two
// connections and about 1.25 s median, 1.5 s p90, on one. Only the header's
// history (the first Session, the last request, the Systems, and whether a
// repository was resolved) reads the project's Sessions over the whole
// archive, once. Every other read starts
// from the project's Sessions with a request in the period, found as Agents
// finds its Sessions (session-spans.ts), kept to those with such a request.
// They are picked once, and each later statement takes their keys, so the plan
// reaches tool counts, bursts, and subagents by Session key and never re-runs
// the project filter. One rule holds for the whole page: only requests in the period
// count, and a Session with none adds nothing.
//
// Active time is the union, over the project's Sessions, of the 5 minutes
// after each request in the period (the window in which a Session counts as
// running), cut at the period's end, so overlapping Sessions count once and a
// period never holds more active time than its length. The lanes draw the
// same windows, one Session's at a time. Both read the Sessions' bursts the Hub
// stores at each refresh (ADR-0016), so like the totals they can lag new
// requests until the next refresh, and so does the subagent count. The tools
// read the counts stored with the bursts, or a Session's calls in the period
// when a tool's calls cross its edge or the Session awaits a refresh.
//
// The cost by role reads the period the cost figure reads, ending at `now`,
// and picks the project's Sessions as the figure's totals do, so its classes
// sum to the figure (ADR-0025).
export const readProjectView = (
  sql: SQL,
  input: {
    name: string;
    now: number;
    range: AgentsRange;
    timeZone: string;
  },
) => {
  const { name } = input;
  if (name === '') {
    return Promise.resolve(undefined);
  }
  return readSnapshot(sql, input.range === '30d', async (tx, side) => {
    // Every statement is planned for its own values: the activity's take
    // thousands of Session keys as arrays, and a generic plan, which
    // PostgreSQL may switch a prepared statement to after five runs, would
    // plan for ten.
    await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
    if (side !== tx) {
      await side`SET LOCAL plan_cache_mode = force_custom_plan`;
    }
    // The period the overview reads for a project, which ends at `now`. The
    // project's own activity is read beside the header and the overview.
    const { from, to } = agentsPeriod(input);
    const [header, activity] = await settleBoth(
      (async () => {
        const history: {
          first: Date;
          last: Date | null;
          repository: boolean;
          systems: string[];
        }[] = await tx`
        SELECT min(s.started_at) AS first, max(k.last_request_at) AS last,
               bool_or(s.repository IS NOT NULL) AS repository,
               array_agg(DISTINCT s.system ORDER BY s.system) AS systems
        FROM insight.sessions s
        LEFT JOIN insight.session_spans k
          ON (k.harness, k.system, k.source, k.session_id) = (s.harness, s.system, s.source, s.session_id)
        WHERE ${sessionProjectSql(tx)} = ${name}
        HAVING count(*) > 0
      `;
        const place = history[0];
        if (place === undefined) {
          return undefined;
        }
        const [{ overview }, split] = await settleBoth(
          readPeriodOverview(tx, { ...input, project: name }),
          readRoleSplit(tx, { from, project: name, to }),
        );
        return { overview, place, split };
      })(),
      readActivity(side, { from, name, to }),
    );
    if (header === undefined) {
      return undefined;
    }
    const { overview, place, split } = header;
    const { branches, processes, subagents, toolCount, tools, windows } = activity;
    const lanes: ActivityLane[] = windows.map((row) => ({
      end: row.end.getTime(),
      harness: row.harness,
      sessionId: row.session_id,
      source: row.source,
      start: row.start.getTime(),
      system: row.system,
    }));
    const subagentsOf = new Map(subagents.map((row) => [rowKey(row), row.n]));
    const [cpu] = processes;
    return {
      activeMs: unionMs(lanes),
      branches,
      cpuSeconds: cpu?.seconds ?? 0,
      firstSessionAt: place.first.getTime(),
      lanes,
      lastRequestAt: place.last?.getTime(),
      name,
      overview,
      peakRssBytes: cpu?.peak ?? undefined,
      // Whether a repository, not only a folder, names the project.
      repository: place.repository || cpu?.repository === true,
      // The period's cost by role, summing to `overview.totals`.
      roleSplit: split,
      subagents: subagents.reduce((sum, row) => sum + row.n, 0),
      systems: place.systems,
      // The newest Sessions, running first, each with its subagents in the period.
      tail: overview.table.sessions.slice(0, SESSIONS_TAIL).map((session) => ({
        session,
        subagents: subagentsOf.get(keyOf(session)) ?? 0,
      })),
      toolCount,
      tools,
    };
  });
};
export type ProjectView = NonNullable<Awaited<ReturnType<typeof readProjectView>>>;

// The project's activity in the period: its lanes, branches, tools,
// subagents, and processes, read from its Sessions with a request in it.
const readActivity = async (
  tx: SQL,
  { from, name, to }: { from: Date; name: string; to: Date },
) => {
  // The project's Sessions with a request in the period: one of a Session's
  // stored bursts reaches into the period with its first or last request
  // inside it, or, crossing the whole period, holds a request in it, which
  // only a period shorter than the bursts' 5-minute gap can miss. A Session
  // holds a few bursts, so this reads no requests but those. The pick runs
  // once, and each read below takes its keys.
  const picked: Key[] = await tx`
    SELECT k.harness, k.system, k.source, k.session_id
    FROM (${sessionSpans(tx, { from, project: name, to })}) k
    WHERE EXISTS (
      SELECT 1 FROM insight.session_bursts a
      WHERE (a.harness, a.system, a.source, a.session_id) = (k.harness, k.system, k.source, k.session_id)
        AND a.agent_id IS NULL AND a.started_at <= ${to} AND a.ended_at >= ${from}
        AND (a.started_at >= ${from} OR a.ended_at <= ${to} OR EXISTS (
          SELECT 1 FROM insight.request_agents q
          WHERE (q.harness, q.system, q.source, q.session_id) = (k.harness, k.system, k.source, k.session_id)
            AND q.at >= ${from} AND q.at <= ${to}
        ))
    )
  `;
  // The keys go as arrays, whose length the planner reads in a plan made for
  // the statement's values (see readProjectView), so it hashes thousands of
  // Sessions and probes a few by index.
  const spans = tx`
    SELECT * FROM unnest(${picked.map((k) => k.harness)}::text[], ${picked.map((k) => k.system)}::text[],
                         ${picked.map((k) => k.source)}::text[], ${picked.map((k) => k.session_id)}::text[])
      AS k (harness, system, source, session_id)
  `;
  const [windows, branches, tools, subagents, processes] = await settleAll([
    // Each Session's requests in the period, merged into lanes whose
    // requests are at most 5 minutes apart: its stored bursts (of requests at
    // most RUNNING_MS apart) that reach into the period. The requests of a
    // burst inside the period form one lane, so a burst crossing an edge only
    // needs its first request after `from` or its last before `to`, both
    // within the burst, and one that holds none, its gap spanning a short
    // period or its requests changed since the refresh, is dropped.
    tx`
      WITH spans AS MATERIALIZED (${spans}),
      bursts AS MATERIALIZED (
        SELECT k.system, k.harness, k.source, k.session_id, a.started_at, a.ended_at
        FROM spans k
        CROSS JOIN LATERAL (
          SELECT x.started_at, x.ended_at FROM insight.session_bursts x
          WHERE (x.harness, x.system, x.source, x.session_id) = (k.harness, k.system, k.source, k.session_id)
            AND x.agent_id IS NULL AND x.started_at <= ${to} AND x.ended_at >= ${from}
          OFFSET 0
        ) a
      ),
      lanes AS (
        SELECT a.system, a.harness, a.source, a.session_id,
               CASE WHEN a.started_at >= ${from} THEN a.started_at ELSE (
                 SELECT x.at FROM insight.request_agents x
                 WHERE (x.harness, x.system, x.source, x.session_id) = (a.harness, a.system, a.source, a.session_id)
                   AND x.at >= ${from} AND x.at <= a.ended_at
                 ORDER BY x.at LIMIT 1
               ) END AS start,
               CASE WHEN a.ended_at <= ${to} THEN a.ended_at ELSE (
                 SELECT x.at FROM insight.request_agents x
                 WHERE (x.harness, x.system, x.source, x.session_id) = (a.harness, a.system, a.source, a.session_id)
                   AND x.at <= ${to} AND x.at >= a.started_at
                 ORDER BY x.at DESC LIMIT 1
               ) END AS last
        FROM bursts a
      )
      SELECT system, harness, source, session_id, start,
             least(last + ${`${String(RUNNING_MS)} milliseconds`}::interval, ${to}) AS end
      FROM lanes
      WHERE start <= ${to} AND last IS NOT NULL
      ORDER BY start, system, harness, source, session_id
    ` as Promise<(Key & { start: Date; end: Date })[]>,
    // Each branch's Sessions with a request in the period.
    tx`
      WITH spans AS MATERIALIZED (${spans})
      SELECT s.branch AS name, count(*)::int AS sessions
      FROM spans k
      CROSS JOIN LATERAL (
        SELECT coalesce(x.last_git_branch, x.first_git_branch) AS branch FROM insight.sessions x
        WHERE (x.harness, x.system, x.source, x.session_id) = (k.harness, k.system, k.source, k.session_id)
        OFFSET 0
      ) s
      WHERE s.branch IS NOT NULL
      GROUP BY s.branch ORDER BY sessions DESC, s.branch COLLATE "C"
    ` as Promise<Count[]>,
    // Names compare in code unit order, so the order holds in any locale.
    // A Session's tools in the period are its stored counts while
    // session_window_tool_totals would take them: the Hub holds its totals,
    // they are not stale by key or by a range, and no tool's calls cross an
    // edge of the period. Those Sessions' counts are read from the table by
    // key, without the function's checks for each Session; only the others go
    // through the function, which counts their calls. A join over every
    // Session's tool rows sorts or hashes their four-part keys, and at 9,000
    // Sessions it measured slower than reading each Session by its key. The
    // first branch of `counted` copies session_totals_current (migration 54),
    // its twin: PostgreSQL does not inline a function holding subqueries, and
    // calling it for each Session measured about a quarter slower.
    tx`
      WITH spans AS MATERIALIZED (${spans}),
      counted AS MATERIALIZED (
        SELECT k.harness, k.system, k.source, k.session_id FROM spans k
        WHERE NOT EXISTS (
                SELECT 1 FROM stored_session_totals t
                WHERE (t.harness, t.system, t.source, t.session_id)
                    = (k.harness, k.system, k.source, k.session_id)
              ) OR EXISTS (
                SELECT 1 FROM stale_sessions s
                WHERE (s.harness, s.system, s.source, s.session_id)
                    = (k.harness, k.system, k.source, k.session_id)
                  AND s.totals
              ) OR EXISTS (
                SELECT 1 FROM stale_ranges s
                WHERE s.totals AND (s.harness IS NULL OR s.harness = k.harness)
                  AND (s.system IS NULL OR s.system = k.system)
              )
        UNION
        SELECT k.harness, k.system, k.source, k.session_id FROM spans k
        JOIN stored_session_tool_totals t USING (harness, system, source, session_id)
        WHERE t.first_call_at <= ${to} AND t.last_call_at >= ${from}
          AND (t.first_call_at < ${from} OR t.last_call_at > ${to})
      ),
      calls AS (
        SELECT t.name, t.kind, t.mcp_server, t.skill, t.calls FROM spans k
        CROSS JOIN LATERAL (
          SELECT t.name, t.kind, t.mcp_server, t.skill, t.calls FROM stored_session_tool_totals t
          WHERE (t.harness, t.system, t.source, t.session_id) = (k.harness, k.system, k.source, k.session_id)
            AND t.first_call_at >= ${from} AND t.last_call_at <= ${to}
          OFFSET 0
        ) t
        WHERE NOT EXISTS (
          SELECT 1 FROM counted c
          WHERE (c.harness, c.system, c.source, c.session_id) = (k.harness, k.system, k.source, k.session_id)
        )
        UNION ALL
        SELECT t.name, t.kind, t.mcp_server, t.skill, t.calls
        FROM counted k
        CROSS JOIN LATERAL session_window_tool_totals(
          k.harness, k.system, k.source, k.session_id, ${from}, ${to}) t
      )
      SELECT t.name, t.kind, t.mcp_server AS "mcpServer", t.skill, sum(t.calls)::int AS calls,
             (count(*) OVER ())::int AS listed
      FROM calls t
      GROUP BY t.name, t.kind, t.mcp_server, t.skill
      ORDER BY calls DESC, t.name COLLATE "C", t.kind COLLATE "C",
               t.mcp_server COLLATE "C" NULLS FIRST, t.skill COLLATE "C" NULLS FIRST
      LIMIT ${TOOLS_LISTED}
    ` as Promise<(ToolCount & { listed: number })[]>,
    // Like its Session, a subagent counts only with a request in the period:
    // one of its stored bursts reaches into the period with its first or last
    // request inside it, or, crossing the whole period, holds a request in
    // it, which only a period shorter than the bursts' 5-minute gap can miss.
    // Only a subagent the Hub holds has bursts of its own, so the bursts alone
    // give the count. The keys come from insight.session_spans, which already
    // leaves out a Session being re-derived, so the bursts are read from their
    // table, not through insight.session_bursts, which checks that again for
    // every burst.
    tx`
      WITH spans AS MATERIALIZED (${spans})
      SELECT k.system, k.harness, k.source, k.session_id, a.n
      FROM spans k
      CROSS JOIN LATERAL (
        SELECT count(DISTINCT a.agent_id)::int AS n FROM stored_session_bursts a
        WHERE (a.harness, a.system, a.source, a.session_id) = (k.harness, k.system, k.source, k.session_id)
          AND a.agent_id IS NOT NULL AND a.started_at <= ${to} AND a.ended_at >= ${from}
          AND (a.started_at >= ${from} OR a.ended_at <= ${to} OR EXISTS (
            SELECT 1 FROM insight.request_agents q
            WHERE (q.harness, q.system, q.source, q.session_id) = (k.harness, k.system, k.source, k.session_id)
              AND q.agent_id = a.agent_id AND q.at >= ${from} AND q.at <= ${to}
          ))
      ) a
      WHERE a.n > 0
    ` as Promise<(Key & { n: number })[]>,
    // A process counts under its own working directory's project. Its CPU
    // and its peak are those of its 5-minute rollups that overlap the period:
    // the CPU between its first and last reading in them, so none is lost
    // between two buckets.
    tx`
        WITH processes AS MATERIALIZED (
          SELECT p.id, p.repository FROM harness_processes p
          WHERE ${projectNameSql(tx, tx`p.repository`, tx`p.cwd`)} = ${name}
            AND p.started_at <= ${to} AND coalesce(p.ended_at, p.last_seen_at) >= ${from}
        )
        SELECT coalesce((
                 SELECT sum(greatest(0, t.cpu_micros)) / 1e6 FROM (
                   SELECT max(r.cpu_micros_max) - min(r.cpu_micros_min) AS cpu_micros
                   FROM harness_process_rollups r JOIN processes p ON p.id = r.process
                   WHERE r.bucket + interval '5 minutes' > ${from} AND r.bucket <= ${to}
                   GROUP BY r.process) t), 0)::float8 AS seconds,
               (SELECT max(r.rss_max)::float8 FROM harness_process_rollups r JOIN processes p ON p.id = r.process
                WHERE r.bucket + interval '5 minutes' > ${from} AND r.bucket <= ${to}) AS peak,
               coalesce((SELECT bool_or(repository IS NOT NULL) FROM processes), false) AS repository
      ` as Promise<{ peak: number | null; repository: boolean; seconds: number }[]>,
  ]);
  return {
    branches,
    processes,
    subagents,
    // How many distinct tools were called, of which `tools` lists the most called.
    toolCount: tools[0]?.listed ?? 0,
    tools: tools.map(({ calls, kind, mcpServer, name: tool, skill }) => ({
      calls,
      kind,
      mcpServer,
      name: tool,
      skill,
    })),
    windows,
  };
};

// The project page's read: its dossier, or the route's not-found for a name
// no Session's project has.
export const readProjectPage = async (
  sql: SQL,
  input: Parameters<typeof readProjectView>[1],
): Promise<ProjectView> => {
  const view = await readProjectView(sql, input);
  if (view === undefined) {
    throw notFound();
  }
  return view;
};
