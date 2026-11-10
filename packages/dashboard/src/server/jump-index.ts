import type { SQL } from 'bun';

import { projectOf } from './fleet-overview.ts';
import type { JumpIndex } from './jump-index-types.ts';
import { JUMP_SESSION_DAYS } from './jump-index-types.ts';
import { serviceSubjects } from './services.ts';

type PlaceRow = {
  first_cwd: string | null;
  last_cwd: string | null;
  repository: string | null;
};

type SessionRow = PlaceRow & {
  harness: string;
  session_id: string;
  source: string;
  system: string;
};

const projectsOf = (rows: PlaceRow[]) =>
  [
    ...new Set(
      rows.flatMap((row) => {
        const project = projectOf(row.repository, row.last_cwd ?? row.first_cwd);
        return project === undefined ? [] : [project];
      }),
    ),
  ].toSorted();

// The jump box's index at `now`: every System, paired or with history kept,
// by name; each paired System's Services by name; the Sessions whose
// transcript ran in the last 30 days, newest first; and the projects of the
// Sessions with a request in those 30 days, found as the Agents page finds its
// Sessions, so each project opens there with a row to pick. Names only.
export const readJumpIndex = async (sql: SQL, { now }: { now: number }): Promise<JumpIndex> => {
  const since = new Date(now - JUMP_SESSION_DAYS * 86_400_000);
  const to = new Date(now);
  const [systems, services, sessions, places]: [
    { name: string }[],
    { name: string; system: string }[],
    SessionRow[],
    PlaceRow[],
  ] = await Promise.all([
    sql`SELECT name FROM systems UNION SELECT system AS name FROM paired_systems ORDER BY name`,
    sql`SELECT system, name FROM (${serviceSubjects(sql)}) r ORDER BY name, system`,
    sql`
      SELECT harness, system, source, session_id, first_cwd, last_cwd, repository
      FROM insight.sessions
      WHERE ended_at >= ${since}
      ORDER BY ended_at DESC, system, harness, source, session_id
    `,
    sql`
      WITH spans AS MATERIALIZED (
        SELECT harness, system, source, session_id
        FROM insight.session_stretches
        GROUP BY harness, system, source, session_id
        HAVING max(ended_at) >= ${since} AND min(started_at) <= ${to}
      )
      SELECT s.first_cwd, s.last_cwd, s.repository
      FROM spans k
      JOIN insight.sessions s USING (harness, system, source, session_id)
    `,
  ]);
  const jumpSessions = sessions.map((row) => ({
    harness: row.harness,
    project: projectOf(row.repository, row.last_cwd ?? row.first_cwd),
    sessionId: row.session_id,
    source: row.source,
    system: row.system,
  }));
  return {
    projects: projectsOf(places),
    services: services.map(({ name, system }) => ({ name, system })),
    sessions: jumpSessions,
    systems: systems.map(({ name }) => name),
  };
};
