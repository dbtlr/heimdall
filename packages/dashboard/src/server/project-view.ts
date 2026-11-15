import type { SQL } from 'bun';

import type { AgentsRange, SessionsQuery } from './agents-overview-types.ts';
import { agentsPeriod, readAgentsSnapshot } from './agents-overview.ts';
import { projectNameSql, sessionProjectSql } from './project-sql.ts';

type Lane = {
  system: string;
  harness: string;
  source: string;
  sessionId: string;
  start: number;
  end: number;
};
type Count = { name: string; sessions: number };
type ToolCount = {
  name: string;
  kind: string;
  mcpServer: string | null;
  skill: string | null;
  calls: number;
};

// A dossier reads one snapshot. All Session and process reads select the
// project in SQL; no fleet-sized Session payload is filtered in JavaScript.
export const readProjectView = (
  sql: SQL,
  input: {
    name: string;
    now: number;
    range: AgentsRange;
    timeZone: string;
    table?: SessionsQuery;
  },
) =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const { name } = input;
    const selected = tx`SELECT s.* FROM insight.sessions s WHERE ${sessionProjectSql(tx)} = ${name}`;
    const history: { first: Date; last: Date | null; systems: string[] }[] = await tx`
    SELECT min(s.started_at) AS first, max(k.last_request_at) AS last, array_agg(DISTINCT s.system ORDER BY s.system) AS systems
    FROM (${selected}) s
    LEFT JOIN LATERAL (
      SELECT max(x.ended_at) AS last_request_at FROM insight.session_stretches x
      WHERE (x.harness, x.system, x.source, x.session_id) = (s.harness, s.system, s.source, s.session_id)
    ) k ON true
    HAVING count(*) > 0
  `;
    const place = history[0];
    if (name === '' || place === undefined) {
      return undefined;
    }
    const { from, to } = agentsPeriod(input);
    const overview = await readAgentsSnapshot(tx, { ...input, project: name });
    const stretches: {
      system: string;
      harness: string;
      source: string;
      session_id: string;
      start: Date;
      end: Date;
    }[] = await tx`
    SELECT k.system, k.harness, k.source, k.session_id,
      greatest(k.started_at, ${from}) AS start, least(k.ended_at, ${to}) AS end
    FROM insight.session_stretches k JOIN (${selected}) s USING (harness, system, source, session_id)
    WHERE k.ended_at >= ${from} AND k.started_at <= ${to}
    ORDER BY k.system, k.started_at, k.session_id
  `;
    const branches: Count[] = await tx`
    SELECT coalesce(s.last_git_branch, s.first_git_branch) AS name, count(*)::int AS sessions
    FROM (${selected}) s
    WHERE coalesce(s.last_git_branch, s.first_git_branch) IS NOT NULL
      AND EXISTS (SELECT 1 FROM insight.requests r
        WHERE (r.harness, r.system, r.source, r.session_id) = (s.harness, s.system, s.source, s.session_id)
          AND r.at >= ${from} AND r.at <= ${to})
    GROUP BY 1 ORDER BY sessions DESC, name
  `;
    const tools: ToolCount[] = await tx`
    SELECT t.name, t.kind, t.mcp_server AS "mcpServer", t.skill, count(*)::int AS calls
    FROM insight.tool_calls t JOIN (${selected}) s USING (harness, system, source, session_id)
    WHERE t.at >= ${from} AND t.at <= ${to}
    GROUP BY t.name, t.kind, t.mcp_server, t.skill ORDER BY calls DESC, t.name, t.kind, t.mcp_server, t.skill
  `;
    const subagents: { n: number }[] = await tx`
    SELECT count(*)::int AS n FROM insight.subagents a JOIN (${selected}) s USING (harness, system, source, session_id)
    WHERE a.ended_at >= ${from} AND a.started_at <= ${to}
  `;
    const processes = tx`SELECT p.* FROM harness_processes p
    WHERE ${projectNameSql(tx, tx`p.repository`, tx`p.cwd`)} = ${name}
      AND p.started_at <= ${to} AND coalesce(p.ended_at, p.last_seen_at) >= ${from}`;
    const cpu: { seconds: number; peak: number | null }[] = await tx`
    SELECT coalesce((SELECT sum(greatest(0, r.cpu_micros_max - r.cpu_micros_min)) / 1e6
      FROM harness_process_rollups r JOIN (${processes}) p ON p.id = r.process
      WHERE r.bucket >= ${from} AND r.bucket <= ${to}), 0)::float8 AS seconds,
      (SELECT max(peak_rss_bytes)::float8 FROM (${processes}) p) AS peak
  `;
    const lanes: Lane[] = stretches.map((row) => ({
      end: row.end.getTime(),
      harness: row.harness,
      sessionId: row.session_id,
      source: row.source,
      start: row.start.getTime(),
      system: row.system,
    }));
    return {
      activeMs: lanes.reduce((sum, lane) => sum + lane.end - lane.start, 0),
      branches,
      cpuSeconds: cpu[0]?.seconds ?? 0,
      firstSessionAt: place.first.getTime(),
      lanes,
      lastRequestAt: place.last?.getTime(),
      name,
      overview,
      peakRssBytes: cpu[0]?.peak ?? undefined,
      subagents: subagents[0]?.n ?? 0,
      systems: place.systems,
      tools,
    };
  });
export type ProjectView = NonNullable<Awaited<ReturnType<typeof readProjectView>>>;
