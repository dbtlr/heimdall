import { timeline } from '@heimdall/hub/testing';
import type { SubagentFixture } from '@heimdall/hub/testing';
import type { SQL } from 'bun';

// Seeds a month of agent work whose cost splits by role (ADR-0025), for the
// Agents page's Cost by role card: each day an orchestrator Session started by
// hand, whose review panel runs as subagents, and the Sessions T3 delegated
// for it, most tagged with their role and launcher, some that took their role
// from T3's preamble alone. One reviewer Session crosses the 30-day edge.
//
// Called from seed.ts after the other Sessions, before its final refresh.

const HOUR = 3600;
const DAY = 24 * HOUR;
const HOME = '/home/dev';

// Review seats in use, from the panel and beyond it.
const SEATS = ['breaker', 'architect', 'verifier', 'design-rater', 'exitcritic'];
const DELEGATED_ROLES = ['implementation', 'research', 'test'];
const PROJECTS = ['heimdall', 'notes-app', 'cli-tool'];

type Role = { launcher?: string; role: string; seat?: string; source: 'preamble' | 'tag' };

// Records the role the opening named on a Session's main conversation or on
// one of its subagents, as the parser would have.
const giveRole = (
  sql: SQL,
  session: string,
  { launcher, role, seat, source }: Role,
  agent?: string,
) =>
  agent === undefined
    ? sql`
        UPDATE projected_sessions
        SET role = ${role}, seat = ${seat ?? null}, role_source = ${source},
            launching_session_id = ${launcher ?? null}
        WHERE session_id = ${session}
      `
    : sql`
        UPDATE projected_subagents
        SET role = ${role}, seat = ${seat ?? null}, role_source = ${source},
            launching_session_id = ${launcher ?? null}
        WHERE session_id = ${session} AND agent_id = ${agent}
      `;

// `count` request times from `start` seconds, `every` seconds apart.
const times = (start: number, count: number, every = 240) =>
  Array.from({ length: count }, (_, index) => start + index * every);

const pick = (list: readonly string[], index: number): string => list[index % list.length] ?? '';

export const seedRoleSplit = async (sql: SQL, now: number) => {
  const { addSession } = timeline(now);
  // Day 0 is today; the work runs in the hours before now.
  for (let day = 0; day < 30; day += 1) {
    const project = pick(PROJECTS, day);
    const cwd = `${HOME}/projects/${project}`;
    const begin = -day * DAY - 5 * HOUR;
    const orchestrator = `orchestrate-${String(day)}`;
    const seat = pick(SEATS, day);
    const subagents: SubagentFixture[] = [
      { agentId: 'panel', agentType: 'general-purpose', requests: times(begin + 600, 4) },
      // The reviewer's own exploration counts under its seat.
      { agentId: 'panel-explore', parentAgentId: 'panel', requests: times(begin + 900, 2) },
      { agentId: 'explore', agentType: 'Explore', requests: times(begin + 300, 3) },
    ];
    // oxlint-disable-next-line no-await-in-loop -- thirty days of fixture Sessions.
    await addSession(sql, {
      firstCwd: cwd,
      gitBranch: `feat/day-${String(day)}`,
      id: orchestrator,
      inputTokens: 40_000,
      lastCwd: cwd,
      model: 'claude-opus-5-5',
      outputTokens: 1500,
      requests: times(begin, 8, 600),
      subagents,
      system: 'workstation-1',
    });
    // oxlint-disable-next-line no-await-in-loop -- one subagent per Session.
    await giveRole(sql, orchestrator, { role: 'review', seat, source: 'tag' }, 'panel');

    // The Sessions T3 delegated: an implementer or researcher, and a reviewer.
    // Every fourth implementer and every fifth reviewer missed its tag.
    const delegated: { harness: string; id: string; model: string; role: Role; start: number }[] = [
      {
        harness: day % 3 === 0 ? 'codex' : 'claude-code',
        id: `delegate-${String(day)}`,
        model: day % 3 === 0 ? 'gpt-5.1-codex' : 'claude-sonnet-5-5',
        role: {
          launcher: orchestrator,
          role: pick(DELEGATED_ROLES, day),
          source: day % 4 === 1 ? 'preamble' : 'tag',
        },
        start: begin + 1200,
      },
      {
        harness: 'claude-code',
        id: `review-${String(day)}`,
        model: 'claude-sonnet-5-5',
        role: {
          launcher: orchestrator,
          role: 'review',
          seat: pick(SEATS, day + 2),
          source: day % 5 === 2 ? 'preamble' : 'tag',
        },
        start: begin + 2400,
      },
    ];
    for (const session of delegated) {
      // oxlint-disable-next-line no-await-in-loop -- two per day.
      await addSession(sql, {
        firstCwd: cwd,
        harness: session.harness,
        id: session.id,
        inputTokens: 30_000,
        lastCwd: cwd,
        model: session.model,
        outputTokens: 1200,
        requests: times(session.start, 6),
        // A Codex subagent's id is its thread's, so each is unique on its System.
        subagents: [{ agentId: `${session.id}-helper`, requests: times(session.start + 400, 2) }],
        system: session.harness === 'codex' ? 'server-1' : 'workstation-1',
      });
      const { role, source } = session.role;
      // oxlint-disable-next-line no-await-in-loop -- two per day.
      await giveRole(
        sql,
        session.id,
        // A role from the preamble carries no seat and no launcher.
        source === 'tag' ? session.role : { role, source },
      );
    }
  }
  // A reviewer that started before the 30-day period and ran into it, so only
  // its requests inside the period count.
  await addSession(sql, {
    firstCwd: `${HOME}/projects/heimdall`,
    id: 'review-crossing',
    inputTokens: 30_000,
    lastCwd: `${HOME}/projects/heimdall`,
    model: 'claude-sonnet-5-5',
    outputTokens: 1200,
    requests: [...times(-31 * DAY, 4, 3600), ...times(-29.5 * DAY, 4, 3600)],
    system: 'workstation-1',
  });
  await giveRole(sql, 'review-crossing', { role: 'review', seat: 'verifier', source: 'tag' });
};
