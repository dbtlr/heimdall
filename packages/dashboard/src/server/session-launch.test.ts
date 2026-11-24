import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, refreshSessionInsight, startHub, timeline } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { readSessionView } from './session-view.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const { addSession } = timeline(NOW);

// Every request on this model costs $5: 1 input token at $1 and 2 output
// tokens at $2 each. Any other model is unpriced.
const PRICED = 'priced-model';

const start = async () => {
  const h = await startHub();
  await h.db.sql`
    INSERT INTO systems (name, last_seen_at) VALUES ('server-1', now()), ('laptop-1', now())
    ON CONFLICT DO NOTHING
  `;
  await h.db.sql`
    INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES (${PRICED}, '2020-01-01', 'bundled', 1000000, 2000000, 100000)
  `;
  return h;
};

type Tag = {
  launchedBy?: string;
  role?: string;
  roleSource?: 'preamble' | 'tag';
  seat?: string;
};

// Gives Session `id` the facts its opening's tag or preamble would, then
// stores totals again, as the Hub's refresh would after the parse.
const tag = async (h: Hub, id: string, { launchedBy, role, roleSource = 'tag', seat }: Tag) => {
  await h.db.sql`
    UPDATE projected_sessions
    SET role = ${role ?? null}, seat = ${seat ?? null},
        role_source = ${role === undefined ? null : roleSource},
        launching_session_id = ${launchedBy ?? null}
    WHERE session_id = ${id}
  `;
  await refreshSessionInsight(h.db.sql, { budgetMs: Number.POSITIVE_INFINITY });
};

type Member = Tag & {
  id: string;
  harness?: string;
  model?: string;
  requests?: number[];
  system?: string;
};

const add = async (
  h: Hub,
  { harness, id, model = PRICED, requests = [-600], system, ...rest }: Member,
) => {
  await addSession(h.db.sql, {
    gitBranch: 'main',
    id,
    lastCwd: `/srv/work/${id}`,
    model,
    requests,
    ...(harness === undefined ? {} : { harness }),
    ...(system === undefined ? {} : { system }),
  });
  if (Object.keys(rest).length > 0) {
    await tag(h, id, rest);
  }
};

const KEY = { harness: 'claude-code', sessionId: 's1', source: 'claude-code', system: 'laptop-1' };

const launch = async (h: Hub, sessionId = 's1') => {
  const found = await readSessionView(h.db.sql, { ...KEY, sessionId });
  if (found === undefined) {
    throw new Error('no Session view');
  }
  return found.launch;
};

describe('the launching Session', () => {
  test('resolves to the one held Session with the id, on any Harness and System', async () => {
    await using h = await start();
    await add(h, { harness: 'codex', id: 'p1', requests: [-3600, -3000], system: 'server-1' });
    await add(h, { id: 's1', launchedBy: 'p1', role: 'implementation' });

    expect((await launch(h)).launcher).toEqual({
      session: {
        branch: 'main',
        endedAt: NOW - 3000 * 1000,
        harness: 'codex',
        project: 'p1',
        sessionId: 'p1',
        source: 'codex',
        startedAt: NOW - 3600 * 1000,
        system: 'server-1',
      },
      state: 'resolved',
    });
  });

  test('keeps the raw id when no held Session has it', async () => {
    await using h = await start();
    await add(h, { id: 's1', launchedBy: '9b2e7d41-55aa-4c3e-9f10-2d8e6b1c7a03', role: 'review' });

    expect((await launch(h)).launcher).toEqual({
      id: '9b2e7d41-55aa-4c3e-9f10-2d8e6b1c7a03',
      state: 'unmatched',
    });
  });

  test('is absent when the Session named none', async () => {
    await using h = await start();
    await add(h, { id: 's1', role: 'research' });

    const found = await launch(h);
    expect(found.launcher).toBeUndefined();
    expect(found.tree).toBeUndefined();
  });
});

describe('the Session’s role', () => {
  test('a review Session carries its seat and counts as review', async () => {
    await using h = await start();
    await add(h, { id: 's1', role: 'review', seat: 'breaker' });

    expect(await launch(h)).toMatchObject({
      effectiveRole: 'review',
      effectiveSeat: 'breaker',
      role: 'review',
      roleClass: 'review',
      roleSource: 'tag',
      seat: 'breaker',
    });
  });

  test('a review tag with no seat leaves the seat unknown', async () => {
    await using h = await start();
    await add(h, { id: 's1', role: 'review' });

    const found = await launch(h);
    expect(found).toMatchObject({ role: 'review', roleClass: 'review' });
    expect(found.seat).toBeUndefined();
    expect(found.effectiveSeat).toBeUndefined();
  });

  test('a role from T3 Code’s preamble says so', async () => {
    await using h = await start();
    await add(h, { id: 's1', role: 'review', roleSource: 'preamble' });

    expect(await launch(h)).toMatchObject({ role: 'review', roleSource: 'preamble' });
  });

  test('a Session with no role counts as main', async () => {
    await using h = await start();
    await add(h, { id: 's1' });

    const found = await launch(h);
    expect(found).toMatchObject({ roleClass: 'main' });
    expect(found.role).toBeUndefined();
    expect(found.roleSource).toBeUndefined();
  });

  test('each subagent carries its effective role, its own or the Session’s', async () => {
    await using h = await start();
    await addSession(h.db.sql, {
      id: 's1',
      model: PRICED,
      requests: [-600],
      subagents: [
        { agentId: 'a-review', requests: [-500] },
        { agentId: 'a-plain', requests: [-400] },
      ],
    });
    await h.db.sql`
      UPDATE projected_subagents SET role = 'review', seat = 'architect', role_source = 'tag'
      WHERE agent_id = 'a-review'
    `;
    await tag(h, 's1', { role: 'implementation' });

    const found = await readSessionView(h.db.sql, KEY);
    expect(
      found?.agents.map(({ agentId, effectiveRole, effectiveSeat, roleClass }) => ({
        agentId,
        effectiveRole,
        effectiveSeat,
        roleClass,
      })),
    ).toEqual([
      {
        agentId: 'a-review',
        effectiveRole: 'review',
        effectiveSeat: 'architect',
        roleClass: 'review',
      },
      {
        agentId: 'a-plain',
        effectiveRole: 'implementation',
        effectiveSeat: undefined,
        roleClass: 'delegated',
      },
    ]);
  });
});

// s1 launched c1 and c2; c2 launched g1, on another System.
const tree = async (h: Hub, { unpriced = false } = {}) => {
  await add(h, { id: 's1', requests: [-3600, -3000], role: 'implementation' });
  await add(h, { id: 'c1', launchedBy: 's1', requests: [-2000], role: 'review', seat: 'verifier' });
  await add(h, {
    harness: 'codex',
    id: 'c2',
    launchedBy: 's1',
    requests: [-2500],
    role: 'test',
    system: 'server-1',
  });
  await add(h, {
    id: 'g1',
    launchedBy: 'c2',
    model: unpriced ? 'unpriced-model' : PRICED,
    requests: [-1000, -900],
    role: 'research',
  });
};

describe('the launch tree', () => {
  test('lists the Session first, then every Session it launched, with its parent', async () => {
    await using h = await start();
    await tree(h);

    const members = (await launch(h)).tree?.members ?? [];
    expect(
      members.map(({ costUsd, parent, role, roleClass, seat, sessionId, system, totaled }) => ({
        costUsd,
        parent: parent?.sessionId,
        role,
        roleClass,
        seat,
        sessionId,
        system,
        totaled,
      })),
    ).toEqual([
      {
        costUsd: 10,
        parent: undefined,
        role: 'implementation',
        roleClass: 'delegated',
        seat: undefined,
        sessionId: 's1',
        system: 'laptop-1',
        totaled: true,
      },
      {
        costUsd: 5,
        parent: 's1',
        role: 'test',
        roleClass: 'delegated',
        seat: undefined,
        sessionId: 'c2',
        system: 'server-1',
        totaled: true,
      },
      {
        costUsd: 5,
        parent: 's1',
        role: 'review',
        roleClass: 'review',
        seat: 'verifier',
        sessionId: 'c1',
        system: 'laptop-1',
        totaled: true,
      },
      {
        costUsd: 10,
        parent: 'c2',
        role: 'research',
        roleClass: 'delegated',
        seat: undefined,
        sessionId: 'g1',
        system: 'laptop-1',
        totaled: true,
      },
    ]);
  });

  test('puts the Session first even when one it launched started earlier', async () => {
    await using h = await start();
    await add(h, { id: 's1', requests: [-3600], role: 'implementation' });
    await add(h, { id: 'early', launchedBy: 's1', requests: [-7200], role: 'research' });

    const members = (await launch(h)).tree?.members ?? [];
    expect(members.map(({ sessionId }) => sessionId)).toEqual(['s1', 'early']);
  });

  test('a launched Session’s own tree holds only what it launched', async () => {
    await using h = await start();
    await tree(h);

    const own = await readSessionView(h.db.sql, {
      harness: 'codex',
      sessionId: 'c2',
      source: 'codex',
      system: 'server-1',
    });
    expect(own?.launch.tree?.members.map((member) => member.sessionId)).toEqual(['c2', 'g1']);
  });

  test('totals every request when each is priced', async () => {
    await using h = await start();
    await tree(h);

    expect((await launch(h)).tree?.total).toEqual({
      costUsd: 30,
      missingSessions: 0,
      pricedCostUsd: 30,
      requests: 6,
      sessions: 4,
      unpricedRequests: 0,
    });
  });

  test('gives only a lower bound while a request is unpriced', async () => {
    await using h = await start();
    await tree(h, { unpriced: true });

    const found = await launch(h);
    expect(found.tree?.total).toEqual({
      costUsd: undefined,
      missingSessions: 0,
      pricedCostUsd: 20,
      requests: 6,
      sessions: 4,
      unpricedRequests: 2,
    });
    expect(found.tree?.members.find((member) => member.sessionId === 'g1')).toMatchObject({
      costUsd: undefined,
      pricedCostUsd: 0,
      unpricedRequests: 2,
    });
  });

  test('gives a priced subtotal while a member’s totals are not stored yet', async () => {
    await using h = await start();
    await tree(h);
    await h.db.sql`DELETE FROM stored_session_totals WHERE session_id = 'g1'`;

    const found = await launch(h);
    expect(found.tree?.total).toEqual({
      costUsd: undefined,
      missingSessions: 1,
      pricedCostUsd: 20,
      requests: 4,
      sessions: 4,
      unpricedRequests: 0,
    });
    expect(found.tree?.members.find((member) => member.sessionId === 'g1')).toMatchObject({
      costUsd: undefined,
      totaled: false,
    });
  });
});
