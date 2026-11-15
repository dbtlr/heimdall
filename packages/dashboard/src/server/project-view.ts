import { notFound } from '@tanstack/react-router';
import type { SQL } from 'bun';

import { RUNNING_MS } from '../lib/home-agents.ts';
import { unionMs } from '../lib/project-activity.ts';
import type { AgentsRange, AgentsSession } from './agents-overview-types.ts';
import { agentsPeriod, readPeriodOverview } from './agents-overview.ts';
import { projectNameSql, sessionProjectSql } from './project-sql.ts';
import { sessionSpans } from './session-spans.ts';

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

type Key = { harness: string; system: string; source: string; session_id: string };
const keyOf = (row: Pick<AgentsSession, 'harness' | 'sessionId' | 'source' | 'system'>) =>
  JSON.stringify([row.system, row.harness, row.source, row.sessionId]);
const rowKey = (row: Key) => JSON.stringify([row.system, row.harness, row.source, row.session_id]);

// A dossier reads one snapshot. Only the header's history (the first Session,
// the last request, the Systems, and whether a repository was resolved) reads
// the project's Sessions over the whole archive, once. Every other read starts
// from the project's Sessions active in the period, found as Agents finds its
// Sessions (session-spans.ts) and materialized once per statement, so the
// plan reaches tool calls, requests, and subagents by Session key and never
// re-runs the project filter per row.
//
// Active time is the union, over the project's Sessions, of the 5 minutes
// after each request (the window in which a Session counts as running),
// clipped to the period, so overlapping Sessions count once and a period never
// holds more active time than its length. The lanes draw the same windows,
// one Session's at a time.
export const readProjectView = (
  sql: SQL,
  input: {
    name: string;
    now: number;
    range: AgentsRange;
    timeZone: string;
  },
) =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const { name } = input;
    if (name === '') {
      return undefined;
    }
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
      LEFT JOIN LATERAL (
        SELECT max(x.ended_at) AS last_request_at FROM insight.session_stretches x
        WHERE (x.harness, x.system, x.source, x.session_id) = (s.harness, s.system, s.source, s.session_id)
      ) k ON true
      WHERE ${sessionProjectSql(tx)} = ${name}
      HAVING count(*) > 0
    `;
    const place = history[0];
    if (place === undefined) {
      return undefined;
    }
    const { from, to } = agentsPeriod(input);
    const spans = (since: Date) => sessionSpans(tx, { from: since, project: name, to });
    const windowFrom = new Date(from.getTime() - RUNNING_MS);
    const [overview, windows, branches, tools, subagents, processes] = await Promise.all([
      readPeriodOverview(tx, { ...input, project: name }),
      // Each Session's requests from 5 minutes before the period, merged into
      // runs whose requests are at most 5 minutes apart.
      tx`
        WITH spans AS MATERIALIZED (${spans(windowFrom)}),
        requests AS (
          SELECT k.system, k.harness, k.source, k.session_id, r.at,
                 CASE WHEN r.at - lag(r.at) OVER w <= ${`${String(RUNNING_MS)} milliseconds`}::interval
                   THEN 0 ELSE 1 END AS opens
          FROM spans k
          CROSS JOIN LATERAL (
            SELECT x.at FROM insight.requests x
            WHERE (x.harness, x.system, x.source, x.session_id) = (k.harness, k.system, k.source, k.session_id)
              AND x.at >= ${windowFrom} AND x.at <= ${to}
            OFFSET 0
          ) r
          WINDOW w AS (PARTITION BY k.system, k.harness, k.source, k.session_id ORDER BY r.at)
        ),
        runs AS (
          SELECT *, sum(opens) OVER (
            PARTITION BY system, harness, source, session_id ORDER BY at ROWS UNBOUNDED PRECEDING
          ) AS run
          FROM requests
        )
        SELECT system, harness, source, session_id,
               greatest(min(at), ${from}) AS start,
               least(max(at) + ${`${String(RUNNING_MS)} milliseconds`}::interval, ${to}) AS end
        FROM runs
        GROUP BY system, harness, source, session_id, run
        HAVING max(at) + ${`${String(RUNNING_MS)} milliseconds`}::interval > ${from}
        ORDER BY start, system, harness, source, session_id
      ` as Promise<(Key & { start: Date; end: Date })[]>,
      // Each branch's Sessions active in the period: the spans are its period filter.
      tx`
        WITH spans AS MATERIALIZED (${spans(from)})
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
      tx`
        WITH spans AS MATERIALIZED (${spans(from)})
        SELECT t.name, t.kind, t.mcp_server AS "mcpServer", t.skill, count(*)::int AS calls,
               (count(*) OVER ())::int AS listed
        FROM spans k
        CROSS JOIN LATERAL (
          SELECT x.name, x.kind, x.mcp_server, x.skill FROM insight.tool_calls x
          WHERE (x.harness, x.system, x.source, x.session_id) = (k.harness, k.system, k.source, k.session_id)
            AND x.at >= ${from} AND x.at <= ${to}
          OFFSET 0
        ) t
        GROUP BY t.name, t.kind, t.mcp_server, t.skill
        ORDER BY calls DESC, t.name COLLATE "C", t.kind COLLATE "C",
                 t.mcp_server COLLATE "C" NULLS FIRST, t.skill COLLATE "C" NULLS FIRST
        LIMIT ${TOOLS_LISTED}
      ` as Promise<(ToolCount & { listed: number })[]>,
      tx`
        WITH spans AS MATERIALIZED (${spans(from)})
        SELECT k.system, k.harness, k.source, k.session_id, a.n
        FROM spans k
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS n FROM insight.subagents x
          WHERE (x.harness, x.system, x.source, x.session_id) = (k.harness, k.system, k.source, k.session_id)
            AND x.ended_at >= ${from} AND x.started_at <= ${to}
        ) a
        WHERE a.n > 0
      ` as Promise<(Key & { n: number })[]>,
      // A process counts under its own working directory's project. Its CPU
      // and its peak are its rollups' within the period.
      tx`
        WITH processes AS MATERIALIZED (
          SELECT p.id, p.repository FROM harness_processes p
          WHERE ${projectNameSql(tx, tx`p.repository`, tx`p.cwd`)} = ${name}
            AND p.started_at <= ${to} AND coalesce(p.ended_at, p.last_seen_at) >= ${from}
        )
        SELECT coalesce((
                 SELECT sum(greatest(0, r.cpu_micros_max - r.cpu_micros_min)) / 1e6
                 FROM harness_process_rollups r JOIN processes p ON p.id = r.process
                 WHERE r.bucket >= ${from} AND r.bucket <= ${to}), 0)::float8 AS seconds,
               (SELECT max(r.rss_max)::float8 FROM harness_process_rollups r JOIN processes p ON p.id = r.process
                WHERE r.bucket >= ${from} AND r.bucket <= ${to}) AS peak,
               coalesce((SELECT bool_or(repository IS NOT NULL) FROM processes), false) AS repository
      ` as Promise<{ peak: number | null; repository: boolean; seconds: number }[]>,
    ]);
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
      subagents: subagents.reduce((sum, row) => sum + row.n, 0),
      systems: place.systems,
      // The newest Sessions, running first, each with its subagents in the period.
      tail: overview.table.sessions.slice(0, SESSIONS_TAIL).map((session) => ({
        session,
        subagents: subagentsOf.get(keyOf(session)) ?? 0,
      })),
      // How many distinct tools were called, of which `tools` lists the most called.
      toolCount: tools[0]?.listed ?? 0,
      tools: tools.map(({ calls, kind, mcpServer, name: tool, skill }) => ({
        calls,
        kind,
        mcpServer,
        name: tool,
        skill,
      })),
    };
  });
export type ProjectView = NonNullable<Awaited<ReturnType<typeof readProjectView>>>;

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
