import { notFound } from '@tanstack/react-router';
import type { SQL } from 'bun';

import { RUNNING_MS } from '../lib/home-agents.ts';
import { unionMs } from '../lib/project-activity.ts';
import type { AgentsRange, AgentsSession } from './agents-overview-types.ts';
import { agentsPeriod, readPeriodOverview } from './agents-overview.ts';
import { projectNameSql, sessionProjectSql } from './project-sql.ts';
import { readRoleSplit } from './role-split.ts';
import { readSnapshot, settleAll } from './snapshot.ts';

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

// A dossier reads one snapshot, on one connection. At production scale
// (9,000 Sessions in the period, the heavy scenario) its 30-day read takes
// about 0.63 to 0.70 s p90 on one connection. The previous default read took
// about 0.81 s p90 by borrowing a second connection, and about 1.1 to 1.3 s on
// one. The cost overview, shared with the Agents page, takes about half. One statement reads the header's history over the whole
// archive and picks the project's Sessions with a request in the period,
// found as Agents finds its Sessions (session-spans.ts), kept to those with
// such a request (readPlace), so the project filter runs once. Each later
// statement takes the picked Sessions' keys (session_keys), so it matches
// the stored bursts and tool counts by one integer and never re-runs the
// project filter. One rule holds for the whole page: only requests in the
// period count, and a Session with none adds nothing.
//
// Active time is the union, over the project's Sessions, of the 5 minutes
// after each request in the period (the window in which a Session counts as
// running), cut at the period's end, so overlapping Sessions count once and a
// period never holds more active time than its length. The lanes draw the
// same windows, one Session's at a time. Both read the Sessions' bursts the Hub
// stores at each refresh (ADR-0016), so like the totals they can lag new
// requests until the next refresh, and so does the subagent count, read from
// the count stored with the totals or, at the period's edge, the bursts. The
// tools read the counts stored with the bursts, or a Session's calls in the
// period when a tool's calls cross its edge or the Session awaits a refresh.
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
  return readSnapshot(sql, false, async (tx) => {
    // Every statement is planned for its own values: the activity's take
    // thousands of Session keys as arrays, and a generic plan, which
    // PostgreSQL may switch a prepared statement to after five runs, would
    // plan for ten.
    await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
    // The period the overview reads for a project, which ends at `now`.
    const { from, to } = agentsPeriod(input);
    const place = await readPlace(tx, { from, name, to });
    if (place === undefined) {
      return undefined;
    }
    const [{ overview }, split, activity] = await settleAll([
      readPeriodOverview(tx, { ...input, project: name }),
      readRoleSplit(tx, { from, project: name, to }),
      readActivity(tx, { from, name, picked: place.picked, to }),
    ]);
    const { processes, toolCount, tools, windows } = activity;
    const { sessions } = place.picked;
    const lanes: ActivityLane[] = windows.map((row) => ({
      end: row.end.getTime(),
      harness: row.harness,
      sessionId: row.session_id,
      source: row.source,
      start: row.start.getTime(),
      system: row.system,
    }));
    const subagentsOf = new Map(sessions.map((row) => [rowKey(row), row.subagents]));
    const [cpu] = processes;
    return {
      activeMs: unionMs(lanes),
      branches: place.branches,
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
      subagents: sessions.reduce((sum, row) => sum + row.subagents, 0),
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

// The project's Sessions with a request in the period, each as its parts.
type Picked = {
  // Each picked Session's key, and its subagents with a request in the period.
  sessions: (Key & { subagents: number })[];
  // The stored keys of the Sessions whose tools are their stored counts.
  storedTools: string[];
  // The Sessions whose tools are counted from their calls in the period.
  countedTools: Key[];
  // The stored keys of the picked Sessions the Hub holds totals for.
  sessionKeys: string[];
};

// The header's history, the project's Sessions with a request in the period,
// and what the page reads once per Session, in one statement, so the project
// filter runs once. The history (the first Session, the last request, the
// Systems, and whether a repository was resolved) reads the project's
// Sessions over the whole archive.
//
// A Session is picked when it has a request in the period: one of its
// stored bursts reaches into the period with its first or last request inside
// it, or, crossing the whole period, holds a request in it, which only a
// period shorter than the bursts' 5-minute gap can miss. A Session whose
// first and last request lie inside the period has such a burst, as its
// bursts hold the requests its bounds do (ADR-0016), so only a Session
// crossing an edge has its bursts read. That holds only for a Session with a
// stored totals row, which is stored with its bursts: a Session with stretches
// but no totals has no bursts, so the shortcut would pick a Session that the
// bursts alone do not. Each branch counts its picked Sessions.
//
// Like its Session, a subagent counts only with a request in the period, by
// the same rule over its own bursts. Only a subagent the Hub holds has bursts
// of its own, so the bursts alone give the count. A Session whose subagents'
// bursts all lie in the period counts each of them, as stored with its totals
// (migration 59); only one at an edge reads its subagents' bursts.
//
// A Session's tools in the period are its stored counts while
// session_window_tool_totals would take them: the Hub holds its totals, they
// are not stale by key or by a range, and no tool's calls cross an edge of
// the period, which only a Session whose calls do not all lie in the period
// can have. The check copies session_totals_current (migration 54), its twin:
// PostgreSQL does not inline a function holding subqueries, and calling it for
// each Session measured about a quarter slower. Every other Session's tools go
// through the function, which counts its calls.
const readPlace = async (tx: SQL, { from, name, to }: { from: Date; name: string; to: Date }) => {
  const rows: {
    branch_names: string[] | null;
    branch_sessions: number[] | null;
    counted: boolean[] | null;
    first: Date;
    harnesses: string[] | null;
    last: Date | null;
    picked_systems: string[] | null;
    repository: boolean;
    session_ids: string[] | null;
    sources: string[] | null;
    subagents: number[] | null;
    systems: string[];
    session_keys: (string | null)[] | null;
  }[] = await tx`
    WITH project AS MATERIALIZED (
      SELECT s.harness, s.system, s.source, s.session_id, s.started_at,
             s.repository IS NOT NULL AS repository,
             coalesce(s.last_git_branch, s.first_git_branch) AS branch,
             k.first_request_at, k.last_request_at, tt.session_key IS NOT NULL AS has_totals
      FROM insight.sessions s
      LEFT JOIN insight.session_spans k
        ON (k.harness, k.system, k.source, k.session_id) = (s.harness, s.system, s.source, s.session_id)
      LEFT JOIN stored_session_totals tt
        ON (tt.harness, tt.system, tt.source, tt.session_id) = (s.harness, s.system, s.source, s.session_id)
      WHERE ${sessionProjectSql(tx)} = ${name}
    ),
    picked AS MATERIALIZED (
      SELECT k.harness, k.system, k.source, k.session_id, k.branch
      FROM project k
      WHERE k.last_request_at >= ${from} AND k.first_request_at <= ${to}
        AND ((k.first_request_at >= ${from} AND k.last_request_at <= ${to} AND k.has_totals)
             OR EXISTS (
          SELECT 1 FROM insight.session_bursts a
          WHERE (a.harness, a.system, a.source, a.session_id) = (k.harness, k.system, k.source, k.session_id)
            AND a.agent_id IS NULL AND a.started_at <= ${to} AND a.ended_at >= ${from}
            AND (a.started_at >= ${from} OR a.ended_at <= ${to} OR EXISTS (
              SELECT 1 FROM insight.request_agents q
              WHERE (q.harness, q.system, q.source, q.session_id) = (k.harness, k.system, k.source, k.session_id)
                AND q.at >= ${from} AND q.at <= ${to}
            ))
        ))
    ),
    -- The keys come from insight.session_spans, which already leaves out a
    -- Session being re-derived, so the stored rows are read from their tables.
    sessions AS MATERIALIZED (
      SELECT k.harness, k.system, k.source, k.session_id, t.session_key::text AS session_key,
             CASE
               WHEN t.session_key IS NULL OR t.subagents = 0 THEN 0
               WHEN t.subagents_first_at >= ${from} AND t.subagents_last_at <= ${to} THEN t.subagents
               ELSE (
                 SELECT count(DISTINCT a.agent_id)::int FROM stored_session_bursts a
                 WHERE a.session_key = t.session_key
                   AND a.agent_id IS NOT NULL AND a.started_at <= ${to} AND a.ended_at >= ${from}
                   AND (a.started_at >= ${from} OR a.ended_at <= ${to} OR EXISTS (
                     SELECT 1 FROM insight.request_agents q
                     WHERE (q.harness, q.system, q.source, q.session_id)
                         = (k.harness, k.system, k.source, k.session_id)
                       AND q.agent_id = a.agent_id AND q.at >= ${from} AND q.at <= ${to}
                   ))
               )
             END AS subagents,
             t.session_key IS NULL OR x.totals OR EXISTS (
               SELECT 1 FROM stale_ranges s
               WHERE s.totals AND (s.harness IS NULL OR s.harness = k.harness)
                 AND (s.system IS NULL OR s.system = k.system)
             ) OR (
               NOT coalesce(t.tools_first_at >= ${from} AND t.tools_last_at <= ${to}, true)
               AND EXISTS (
                 SELECT 1 FROM stored_session_tool_totals c
                 WHERE c.session_key = t.session_key
                   AND c.first_call_at <= ${to} AND c.last_call_at >= ${from}
                   AND (c.first_call_at < ${from} OR c.last_call_at > ${to})
               )
             ) AS counted
      FROM picked k
      LEFT JOIN stored_session_totals t
        ON (t.harness, t.system, t.source, t.session_id) = (k.harness, k.system, k.source, k.session_id)
      LEFT JOIN stale_sessions x
        ON (x.harness, x.system, x.source, x.session_id) = (k.harness, k.system, k.source, k.session_id)
       AND x.totals
    )
    SELECT h.first, h.last, h.repository, h.systems, p.harnesses, p.picked_systems, p.sources,
           p.session_ids, p.session_keys, p.subagents, p.counted, b.branch_names, b.branch_sessions
    FROM (
      SELECT min(started_at) AS first, max(last_request_at) AS last, bool_or(repository) AS repository,
             array_agg(DISTINCT system ORDER BY system) AS systems
      FROM project
      HAVING count(*) > 0
    ) h
    CROSS JOIN (
      SELECT array_agg(harness) AS harnesses, array_agg(system) AS picked_systems,
             array_agg(source) AS sources, array_agg(session_id) AS session_ids,
             array_agg(session_key) AS session_keys, array_agg(subagents) AS subagents,
             array_agg(counted) AS counted
      FROM sessions
    ) p
    CROSS JOIN (
      SELECT array_agg(name ORDER BY sessions DESC, name COLLATE "C") AS branch_names,
             array_agg(sessions ORDER BY sessions DESC, name COLLATE "C") AS branch_sessions
      FROM (
        SELECT branch AS name, count(*)::int AS sessions FROM picked
        WHERE branch IS NOT NULL GROUP BY branch
      ) c
    ) b
  `;
  const [row] = rows;
  if (row === undefined) {
    return undefined;
  }
  const names = row.branch_names ?? [];
  const counts = row.branch_sessions ?? [];
  const picked: Picked = { countedTools: [], sessionKeys: [], sessions: [], storedTools: [] };
  for (const [i, session_id] of (row.session_ids ?? []).entries()) {
    const key: Key = {
      harness: row.harnesses?.[i] ?? '',
      session_id,
      source: row.sources?.[i] ?? '',
      system: row.picked_systems?.[i] ?? '',
    };
    const sessionKey = row.session_keys?.[i] ?? null;
    picked.sessions.push({ ...key, subagents: row.subagents?.[i] ?? 0 });
    if (sessionKey !== null) {
      picked.sessionKeys.push(sessionKey);
    }
    if (row.counted?.[i] === true || sessionKey === null) {
      picked.countedTools.push(key);
    } else {
      picked.storedTools.push(sessionKey);
    }
  }
  return {
    branches: names.map((branch, i): Count => ({ name: branch, sessions: counts[i] ?? 0 })),
    first: row.first,
    last: row.last,
    picked,
    repository: row.repository,
    systems: row.systems,
  };
};

// The project's activity in the period: its lanes, tools, and processes, read
// from its picked Sessions.
const readActivity = async (
  tx: SQL,
  { from, name, picked, to }: { from: Date; name: string; picked: Picked; to: Date },
) => {
  // A Session's stored rows are matched by its key in session_keys, which
  // every stored row carries, given as an array whose length the planner
  // reads in a plan made for the statement's values (see readProjectView):
  // it hashes thousands and scans the rows once, or probes a few by index.
  const counted = picked.countedTools;
  const [windows, tools, processes] = await settleAll([
    // Each Session's requests in the period, merged into lanes whose
    // requests are at most 5 minutes apart: its stored bursts (of requests at
    // most RUNNING_MS apart) that reach into the period. The requests of a
    // burst inside the period form one lane, so a burst crossing an edge only
    // needs its first request after `from` or its last before `to`, both
    // within the burst, and one that holds none, its gap spanning a short
    // period or its requests changed since the refresh, is dropped.
    tx`
      WITH bursts AS MATERIALIZED (
        SELECT x.system, x.harness, x.source, x.session_id, x.started_at, x.ended_at
        FROM stored_session_bursts x
        WHERE x.session_key = ANY(${picked.sessionKeys}::bigint[]) AND x.agent_id IS NULL
          AND x.started_at <= ${to} AND x.ended_at >= ${from}
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
    // Names compare in code unit order, so the order holds in any locale.
    // The stored counts inside the period, summed from one pass over the
    // stored rows, and each counted Session's calls in it (see readPlace).
    tx`
      WITH calls AS (
        SELECT t.name, t.kind, t.mcp_server, t.skill, t.calls FROM stored_session_tool_totals t
        WHERE t.session_key = ANY(${picked.storedTools}::bigint[])
          AND t.first_call_at >= ${from} AND t.last_call_at <= ${to}
        UNION ALL
        SELECT t.name, t.kind, t.mcp_server, t.skill, t.calls
        FROM unnest(${counted.map((k) => k.harness)}::text[], ${counted.map((k) => k.system)}::text[],
                    ${counted.map((k) => k.source)}::text[], ${counted.map((k) => k.session_id)}::text[])
          AS k (harness, system, source, session_id)
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
    processes,
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
