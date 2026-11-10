import type { SQL } from 'bun';

import { projectOf } from './fleet-overview.ts';
import type { JumpIndex } from './jump-index-types.ts';
import { JUMP_SESSION_DAYS } from './jump-index-types.ts';
import { serviceSubjects } from './services.ts';

type SessionRow = {
  first_cwd: string | null;
  harness: string;
  last_cwd: string | null;
  repository: string | null;
  session_id: string;
  source: string;
  system: string;
};

// The jump box's index at `now`: every System, paired or with history kept,
// by name; each paired System's Services by name; and the Sessions whose
// transcript ran in the last 30 days, newest first, with the projects they
// belong to. Names only.
export const readJumpIndex = async (sql: SQL, { now }: { now: number }): Promise<JumpIndex> => {
  const since = new Date(now - JUMP_SESSION_DAYS * 86_400_000);
  const [systems, services, sessions]: [
    { name: string }[],
    { name: string; system: string }[],
    SessionRow[],
  ] = await Promise.all([
    sql`SELECT name FROM systems UNION SELECT system AS name FROM paired_systems ORDER BY name`,
    sql`SELECT system, name FROM (${serviceSubjects(sql)}) r ORDER BY name, system`,
    sql`
      SELECT harness, system, source, session_id, first_cwd, last_cwd, repository
      FROM insight.sessions
      WHERE ended_at >= ${since}
      ORDER BY ended_at DESC, system, harness, source, session_id
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
    projects: [
      ...new Set(jumpSessions.flatMap(({ project }) => (project === undefined ? [] : [project]))),
    ].toSorted(),
    services: services.map(({ name, system }) => ({ name, system })),
    sessions: jumpSessions,
    systems: systems.map(({ name }) => name),
  };
};
