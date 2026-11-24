// Seeds Sessions whose session tags give them a role, a review seat, and a
// launching Session (ADR-0025), so the Session page's launch-tree card and
// its cost split by role have something to show. Called from seed.ts.

import { refreshSessionInsight, timeline } from '@heimdall/hub/testing';
import type { RequestFixture, SubagentFixture } from '@heimdall/hub/testing';
import type { SQL } from 'bun';

const HOME = '/home/dev';
const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5-5';
const SOL = 'gpt-6.1-sol';
// A model with no price, so its requests are unpriced.
const LOCAL = 'local-coder-7b';

// The launcher id an unresolved tag names: no Session the Hub holds has it.
const UNHELD_PARENT = '9b2e7d41-55aa-4c3e-9f10-2d8e6b1c7a03';

const minutes = (m: number) => m * 60;

// `count` requests spread over [from, to] minutes after `start` (seconds),
// each a tool round but the last, at a steady size.
const work = (
  start: number,
  from: number,
  to: number,
  count: number,
  {
    cacheRead = 120_000,
    input = 2500,
    model,
    output = 1800,
  }: {
    cacheRead?: number;
    input?: number;
    model?: string;
    output?: number;
  } = {},
): RequestFixture[] =>
  Array.from({ length: count }, (_, index) => ({
    at: start + minutes(from + ((to - from) * index) / Math.max(1, count - 1)),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 2000,
    inputTokens: input,
    ...(model === undefined ? {} : { model }),
    outputTokens: output,
    stopReason: index === count - 1 ? 'end_turn' : 'tool_use',
  }));

type Tag = {
  launchedBy?: string;
  role?: string;
  roleSource?: 'preamble' | 'tag';
  seat?: string;
};

// Gives Session `id` the facts its opening's tag or preamble would.
const tagSession = (sql: SQL, id: string, { launchedBy, role, roleSource = 'tag', seat }: Tag) =>
  sql`
    UPDATE projected_sessions
    SET role = ${role ?? null}, seat = ${seat ?? null},
        role_source = ${role === undefined ? null : roleSource},
        launching_session_id = ${launchedBy ?? null}
    WHERE session_id = ${id}
  `;

const tagSubagent = (sql: SQL, session: string, agent: string, { role, seat }: Tag) =>
  sql`
    UPDATE projected_subagents SET role = ${role ?? null}, seat = ${seat ?? null}, role_source = 'tag'
    WHERE session_id = ${session} AND agent_id = ${agent}
  `;

type Seeded = {
  agents?: { id: string; tag: Tag }[];
  branch: string;
  harness?: 'claude-code' | 'codex';
  harnessVersion?: string;
  id: string;
  project?: string;
  requests: RequestFixture[];
  subagents?: SubagentFixture[];
  system: string;
  tag?: Tag;
};

export const seedLaunchTree = async (sql: SQL, now: number) => {
  const { addSession } = timeline(now);
  const add = async ({
    agents = [],
    branch,
    harness = 'claude-code',
    harnessVersion = harness === 'codex' ? '0.58.0' : '2.1.52',
    id,
    project = 'heimdall',
    requests,
    subagents = [],
    system,
    tag,
  }: Seeded) => {
    const cwd = `${HOME}/src/${project}`;
    await addSession(sql, {
      firstCwd: cwd,
      gitBranch: branch,
      harness,
      harnessVersion,
      id,
      lastCwd: cwd,
      model: harness === 'codex' ? SOL : OPUS,
      requests,
      subagents,
      system,
    });
    if (tag !== undefined) {
      await tagSession(sql, id, tag);
    }
    for (const agent of agents) {
      // oxlint-disable-next-line no-await-in-loop -- a handful of rows.
      await tagSubagent(sql, id, agent.id, agent.tag);
    }
  };

  // The launch tree. A person's Session on the laptop launched a build run's
  // implementer on server-1, which launched research, two reviewers, and a
  // test writer, and the test writer launched research of its own.
  const human = '4f1c2a9e-8b3d-4e61-a5c2-7d9e0f1b2c3a';
  const humanStart = -minutes(150);
  await add({
    branch: 'main',
    id: human,
    requests: work(humanStart, 0, 6, 9, { cacheRead: 60_000 }),
    system: 'laptop-1',
  });

  const implementer = '7e2b9c4d-1a5f-4c8e-b3d7-6f0a2e9c1b84';
  const start = -minutes(142);
  await add({
    agents: [
      { id: 'architect', tag: { role: 'review', seat: 'architect' } },
      { id: 'breaker', tag: { role: 'review', seat: 'breaker' } },
    ],
    branch: 'feat/hmd-289-build-run',
    id: implementer,
    requests: work(start, 0, 132, 131, { cacheRead: 180_000, input: 3000, output: 2500 }),
    subagents: [
      {
        agentId: 'explore',
        agentType: 'Explore',
        requests: work(start, 2, 9, 16, { model: SONNET }),
      },
      { agentId: 'architect', agentType: 'architect', requests: work(start, 52, 61, 18) },
      { agentId: 'breaker', agentType: 'breaker', requests: work(start, 58, 70, 22) },
      {
        agentId: 'explore-2',
        agentType: 'Explore',
        requests: work(start, 90, 112, 27, { model: SONNET }),
      },
    ],
    system: 'server-1',
    tag: { launchedBy: human, role: 'implementation' },
  });

  const launched: Seeded[] = [
    {
      branch: 'feat/hmd-289-build-run',
      id: '3a9c1e7f-2b4d-4f6a-8c0e-5d7b9a1f3e26',
      requests: work(start, 11, 23, 26),
      system: 'server-1',
      tag: { launchedBy: implementer, role: 'research' },
    },
    {
      branch: 'feat/hmd-289-build-run',
      harness: 'codex',
      id: '019a7c3e-5b2d-7f41-9e8a-3c6d0b2f4a17',
      requests: work(start, 82, 100, 60, { cacheRead: 200_000, input: 6000, output: 4000 }),
      system: 'server-1',
      tag: { launchedBy: implementer, role: 'review', seat: 'verifier' },
    },
    {
      branch: 'feat/hmd-289-build-run',
      id: '6d4f8b2a-9c1e-4a7d-b5f3-2e8c0a6d4b91',
      requests: work(start, 82, 91, 17),
      system: 'server-1',
      tag: { launchedBy: implementer, role: 'review', seat: 'design-rater' },
    },
  ];
  const tester = '019a7c41-8d2f-7b63-a1c5-9e4b7d0f2c38';
  launched.push({
    branch: 'feat/hmd-289-build-run',
    harness: 'codex',
    id: tester,
    requests: work(start, 88, 119, 30),
    system: 'laptop-1',
    tag: { launchedBy: implementer, role: 'test' },
  });
  launched.push({
    branch: 'feat/hmd-289-build-run',
    id: '8b1d3f5a-7c9e-4b2d-a6f8-0e2c4a6b8d13',
    requests: work(start, 96, 104, 8),
    system: 'laptop-1',
    tag: { launchedBy: tester, role: 'research' },
  });
  for (const session of launched) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of Sessions.
    await add(session);
  }

  // A reviewer whose tag names a launcher the Hub does not hold, with no seat.
  await add({
    branch: 'main',
    id: '2c8e4a6f-0b1d-4e3f-9a5c-7b9d1f3e5a02',
    project: 'garden-notes',
    requests: work(-minutes(300), 0, 14, 20),
    system: 'workstation-1',
    tag: { launchedBy: UNHELD_PARENT, role: 'review' },
  });
  // A reviewer T3 Code started before the tag convention: its role is from
  // the preamble, so it has no seat and no launcher.
  await add({
    branch: 'main',
    id: '5f7a9c1e-3b5d-4f8a-a2c4-6e8a0c2e4f75',
    project: 'garden-notes',
    requests: work(-minutes(280), 0, 11, 14),
    system: 'workstation-1',
    tag: { role: 'review', roleSource: 'preamble' },
  });

  // A tree with an unpriced request: its total is a lower bound.
  const lowerBound = '0d2f4b6a-8c1e-4a3d-b7f9-1e3c5a7b9d24';
  await add({
    branch: 'local-models',
    id: lowerBound,
    project: 'garden-notes',
    requests: work(-minutes(400), 0, 40, 30),
    system: 'workstation-1',
    tag: { role: 'implementation' },
  });
  await add({
    branch: 'local-models',
    id: '1e3a5c7f-9b2d-4f6e-8a0c-2d4f6b8e0a35',
    project: 'garden-notes',
    requests: [
      ...work(-minutes(400), 10, 20, 6),
      ...work(-minutes(400), 21, 24, 3, { model: LOCAL }),
    ],
    system: 'workstation-1',
    tag: { launchedBy: lowerBound, role: 'research' },
  });

  // A tree with a member the refresh has not totaled yet: only a priced
  // subtotal.
  const incomplete = '4b6d8f0a-2c4e-4a7b-9d1f-3e5a7c9e1b46';
  await add({
    branch: 'tree-wait',
    id: incomplete,
    project: 'garden-notes',
    requests: work(-minutes(500), 0, 30, 24),
    system: 'workstation-1',
    tag: { role: 'implementation' },
  });
  const untotaled = '6f8b0d2c-4e6a-4c9d-b1f3-5a7c9e1d3f57';
  for (const [index, id] of ['5c7e9a1b-3d5f-4b8e-a0c2-4f6b8d0e2a68', untotaled].entries()) {
    // oxlint-disable-next-line no-await-in-loop -- two Sessions.
    await add({
      branch: 'tree-wait',
      harness: index === 0 ? 'claude-code' : 'codex',
      id,
      project: 'garden-notes',
      requests: work(-minutes(500), 5 + index * 8, 12 + index * 8, 10),
      system: 'workstation-1',
      tag: { launchedBy: incomplete, role: index === 0 ? 'research' : 'test' },
    });
  }
  // Store what the tags changed, then drop one member's totals: the refresh
  // stores them again only once the Session goes stale, which it has not.
  await refreshSessionInsight(sql, { budgetMs: Number.POSITIVE_INFINITY });
  await sql`DELETE FROM stored_session_totals WHERE session_id = ${untotaled}`;
};
