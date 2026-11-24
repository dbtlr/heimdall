import { beforeAll, expect, test } from 'bun:test';

import { NOW, refreshSessionInsight, startHub, timeline } from '@heimdall/hub/testing';
import type { SQL } from 'bun';

import { readAgentsOverview } from './agents-overview.ts';
import { readMissedTags, readRoleSplit } from './role-split.ts';

beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

const HOUR_S = 3600;
const DAY_MS = 86_400_000;
const { addSession } = timeline(NOW);
const dollar = { inputTokens: 1_000_000, model: 'test-model', outputTokens: 0 };
// The 7-day period ending at NOW.
const week = { from: new Date(NOW - 7 * DAY_MS), to: new Date(NOW) };

// A Hub whose test-model costs $1 for each request of a million input tokens.
const start = async () => {
  const h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1'), ('laptop-1')`;
  await h.db.sql`
    INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES ('test-model', '2020-01-01', 'bundled', 1, 2, 2000000)
  `;
  return h;
};

type Role = { role: string; seat?: string; source?: 'preamble' | 'tag' };

// Gives a Session's main conversation, or one of its subagents, the role its
// opening named, as the parser would have recorded it.
const giveRole = (
  sql: SQL,
  session: string,
  { role, seat, source = 'tag' }: Role,
  agent?: string,
) =>
  agent === undefined
    ? sql`
        UPDATE projected_sessions SET role = ${role}, seat = ${seat ?? null}, role_source = ${source}
        WHERE session_id = ${session}
      `
    : sql`
        UPDATE projected_subagents SET role = ${role}, seat = ${seat ?? null}, role_source = ${source}
        WHERE session_id = ${session} AND agent_id = ${agent}
      `;

const refreshed = (sql: SQL) => refreshSessionInsight(sql, { budgetMs: Number.POSITIVE_INFINITY });

const cost = (pricedCostUsd: number, unpricedRequests = 0) => ({
  pricedCostUsd,
  requests: pricedCostUsd + unpricedRequests,
  unpricedRequests,
});
const none = cost(0);

test('a Session wholly inside the period splits by its stored totals', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    ...dollar,
    id: 'orchestrator',
    requests: [-5 * HOUR_S, -4 * HOUR_S],
    subagents: [
      { agentId: 'breaker', requests: [-4.5 * HOUR_S, -4.4 * HOUR_S, -4.3 * HOUR_S] },
      // The breaker's own exploration counts as review under its seat.
      { agentId: 'explore', parentAgentId: 'breaker', requests: [-4.2 * HOUR_S] },
      { agentId: 'helper', requests: [-4.1 * HOUR_S] },
    ],
  });
  await giveRole(h.db.sql, 'orchestrator', { role: 'review', seat: 'breaker' }, 'breaker');
  await refreshed(h.db.sql);

  const split = await readRoleSplit(h.db.sql, week);

  expect(split.classes).toEqual({ delegated: cost(1), main: cost(2), review: cost(4) });
  expect(split.seats).toEqual([{ seat: 'breaker', ...cost(4) }]);
});

test('a Session crossing the period prices only its requests inside it, each by its conversation’s role', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    ...dollar,
    id: 'crossing',
    // The main conversation's first request is before the 7-day period.
    requests: [-8 * 24 * HOUR_S, -2 * HOUR_S, { agentId: 'unheld', at: -HOUR_S }],
    subagents: [
      { agentId: 'architect', requests: [-9 * 24 * HOUR_S, -3 * HOUR_S] },
      { agentId: 'tester', requests: [-2.5 * HOUR_S, { at: -2.4 * HOUR_S, model: 'unknown' }] },
    ],
  });
  await giveRole(h.db.sql, 'crossing', { role: 'review', seat: 'architect' }, 'architect');
  await giveRole(h.db.sql, 'crossing', { role: 'test' }, 'tester');
  // A preamble reviewer crossing the period: every conversation is review with no seat.
  await addSession(h.db.sql, {
    ...dollar,
    id: 'preamble-reviewer',
    requests: [-10 * 24 * HOUR_S, -6 * HOUR_S],
    subagentRequests: [-5 * HOUR_S],
  });
  await giveRole(h.db.sql, 'preamble-reviewer', { role: 'review', source: 'preamble' });
  await refreshed(h.db.sql);

  const split = await readRoleSplit(h.db.sql, week);

  // A request of a subagent the Hub does not hold takes the main
  // conversation's role, and as a subagent's request counts as delegated.
  expect(split.classes).toEqual({ delegated: cost(2, 1), main: cost(1), review: cost(3) });
  expect(split.seats.toSorted((a, b) => (a.seat ?? '').localeCompare(b.seat ?? ''))).toEqual([
    { seat: null, ...cost(2) },
    { seat: 'architect', ...cost(1) },
  ]);
});

test('requests past the period’s end count in no class, whether the Session’s stored split or its request pricing is read', async () => {
  await using h = await start();
  // Crossing both edges: only the request inside the period counts.
  await addSession(h.db.sql, {
    ...dollar,
    id: 'both-edges',
    requests: [-8 * 24 * HOUR_S, -HOUR_S, HOUR_S],
  });
  // Wholly inside at its start but with a request past the end: not stored whole.
  await addSession(h.db.sql, {
    ...dollar,
    id: 'past-end',
    requests: [-3 * HOUR_S, -2 * HOUR_S, HOUR_S],
  });
  await refreshed(h.db.sql);

  const split = await readRoleSplit(h.db.sql, week);

  expect(split).toEqual({
    classes: { delegated: none, main: cost(3), review: none },
    seats: [],
  });
});

test('a review Session crossing the period puts its main conversation and its unheld subagents in review under its seat', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    ...dollar,
    id: 'reviewer',
    requests: [-8 * 24 * HOUR_S, -2 * HOUR_S, { agentId: 'unheld', at: -HOUR_S }],
  });
  await giveRole(h.db.sql, 'reviewer', { role: 'review', seat: 'verifier' });
  await refreshed(h.db.sql);

  const split = await readRoleSplit(h.db.sql, week);

  expect(split).toEqual({
    classes: { delegated: none, main: none, review: cost(2) },
    seats: [{ seat: 'verifier', ...cost(2) }],
  });
});

test('a Session the headline does not list is in no class', async () => {
  await using h = await start();
  await addSession(h.db.sql, { ...dollar, id: 'listed', requests: [-HOUR_S] });
  await addSession(h.db.sql, { ...dollar, id: 'unlisted', requests: [-2 * HOUR_S] });
  await refreshed(h.db.sql);
  // As around a parser switch: the Session's totals remain but it is not in insight.sessions.
  await h.db.sql`DELETE FROM projected_sessions WHERE session_id = 'unlisted'`;

  const split = await readRoleSplit(h.db.sql, week);
  const { totals } = await readAgentsOverview(h.db.sql, {
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });

  expect(split.classes.main).toEqual(cost(1));
  expect(totals.pricedCostUsd).toBe(1);
});

test('the classes sum to the Agents page’s period total', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    ...dollar,
    id: 'inside',
    requests: [-HOUR_S],
    subagentRequests: [-0.5 * HOUR_S],
  });
  await addSession(h.db.sql, {
    ...dollar,
    id: 'crossing',
    requests: [-8 * 24 * HOUR_S, -2 * HOUR_S],
    subagentRequests: [-9 * 24 * HOUR_S, -3 * HOUR_S],
    system: 'server-1',
  });
  await giveRole(h.db.sql, 'crossing', { role: 'review', seat: 'verifier' });
  await refreshed(h.db.sql);

  const { roleSplit, totals } = await readAgentsOverview(h.db.sql, {
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });

  const { delegated, main, review } = roleSplit.classes;
  expect(main.pricedCostUsd + review.pricedCostUsd + delegated.pricedCostUsd).toBe(
    totals.pricedCostUsd,
  );
  expect(main.requests + review.requests + delegated.requests).toBe(totals.requests);
  expect(review).toEqual(cost(2));
});

test('a period with no review cost has no seats', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    ...dollar,
    id: 'plain',
    requests: [-HOUR_S],
    subagentRequests: [-0.5 * HOUR_S],
  });
  await addSession(h.db.sql, { ...dollar, id: 'implementer', requests: [-2 * HOUR_S] });
  await giveRole(h.db.sql, 'implementer', { role: 'implementation' });
  await refreshed(h.db.sql);

  const split = await readRoleSplit(h.db.sql, week);

  expect(split).toEqual({
    classes: { delegated: cost(2), main: cost(1), review: none },
    seats: [],
  });
});

test('reads the split with JIT off for the rest of its transaction', async () => {
  await using h = await start();

  const jit = await h.db.sql.begin(async (tx) => {
    await readRoleSplit(tx, week);
    const [row]: { jit: string }[] = await tx`SHOW jit`;
    return row?.jit;
  });

  expect(jit).toBe('off');
});

test('a project’s split counts only its Sessions', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    ...dollar,
    id: 'api',
    lastCwd: '/srv/work/api',
    requests: [-HOUR_S],
  });
  await addSession(h.db.sql, {
    ...dollar,
    id: 'web',
    lastCwd: '/srv/work/web',
    requests: [-HOUR_S],
  });
  await giveRole(h.db.sql, 'web', { role: 'review', seat: 'breaker' });
  await refreshed(h.db.sql);

  const split = await readRoleSplit(h.db.sql, { ...week, project: 'api' });

  expect(split).toEqual({
    classes: { delegated: none, main: cost(1), review: none },
    seats: [],
  });
});

test('the missed tags count the period’s Sessions whose role came from T3’s preamble', async () => {
  await using h = await start();
  const add = async (id: string, at: number, role?: Role) => {
    await addSession(h.db.sql, { ...dollar, id, requests: [at] });
    if (role !== undefined) {
      await giveRole(h.db.sql, id, role);
    }
  };
  await add('started-by-hand', -HOUR_S);
  await add('tagged', -HOUR_S, { role: 'review', seat: 'breaker' });
  await add('tagged-implementer', -2 * HOUR_S, { role: 'implementation' });
  await add('missed', -3 * HOUR_S, { role: 'review', source: 'preamble' });
  // Before the period, so not counted.
  await add('missed-earlier', -8 * 24 * HOUR_S, { role: 'implementation', source: 'preamble' });
  await refreshed(h.db.sql);

  expect(await readMissedTags(h.db.sql, week)).toEqual({ missed: 1, withRole: 3 });

  const { missedTags } = await readAgentsOverview(h.db.sql, {
    now: NOW,
    range: '30d',
    timeZone: 'UTC',
  });
  expect(missedTags).toEqual({ missed: 2, withRole: 4 });
});

test('the missed tags leave out a Session with no stored requests and one whose only requests are past the period', async () => {
  await using h = await start();
  await addSession(h.db.sql, { ...dollar, id: 'counted', requests: [-HOUR_S] });
  await addSession(h.db.sql, { ...dollar, id: 'empty', requests: [-2 * HOUR_S] });
  await addSession(h.db.sql, { ...dollar, id: 'late', requests: [-8 * 24 * HOUR_S, HOUR_S] });
  await Promise.all(
    ['counted', 'empty', 'late'].map((id) =>
      giveRole(h.db.sql, id, { role: 'implementation', source: 'preamble' }),
    ),
  );
  await refreshed(h.db.sql);
  await h.db.sql`UPDATE stored_session_totals SET requests = 0 WHERE session_id = 'empty'`;

  expect(await readMissedTags(h.db.sql, week)).toEqual({ missed: 1, withRole: 1 });
});
