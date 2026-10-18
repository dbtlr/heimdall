import { beforeAll, expect, test } from 'bun:test';

import { NOW, startHub, timeline, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { readAgentsOverview } from './agents-overview.ts';

beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

const { addProcess, addSession } = timeline(NOW);

const start = async () => {
  const h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1'), ('laptop-1')`;
  await h.db.sql`
    INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES ('test-model', '2020-01-01', 'bundled', 1, 2, 2000000)
  `;
  return h;
};

const view = (h: Hub) => readAgentsOverview(h.db.sql, { now: NOW, range: '7d', timeZone: 'UTC' });

test('Today counts only requests since local midnight, including subagents of an older Session', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    id: 'overnight',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-50_401, -50_400, -30],
    subagentRequests: [-20],
    system: 'server-1',
  });

  const result = await readAgentsOverview(h.db.sql, {
    now: NOW,
    range: 'today',
    timeZone: 'Europe/Berlin',
  });
  expect(result.from).toBe(Date.UTC(2026, 9, 5, 22));
  expect(result.totals).toEqual({ pricedCostUsd: 3, requests: 3, unpricedRequests: 0 });
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0]).toMatchObject({
    activeRecently: true,
    lastRequestAt: NOW - 20_000,
    pricedCostUsd: 3,
    requests: 3,
    sessionId: 'overnight',
  });
});

test('whole Sessions retain priced lower bounds, include unpaired history, and keep source identities apart', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    harness: 'codex',
    id: 'same-id',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-300, { at: -60, model: 'unknown' }],
    source: 'personal',
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    harness: 'codex',
    id: 'same-id',
    inputTokens: 2_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-61],
    source: 'work',
    system: 'laptop-1',
  });
  await unpair(h.db.sql, 'laptop-1');

  const result = await view(h);
  expect(result.totals).toEqual({ pricedCostUsd: 3, requests: 3, unpricedRequests: 1 });
  expect(
    result.sessions.map(({ activeRecently, pricedCostUsd, source }) => ({
      activeRecently,
      pricedCostUsd,
      source,
    })),
  ).toEqual([
    { activeRecently: false, pricedCostUsd: 2, source: 'work' },
    { activeRecently: true, pricedCostUsd: 1, source: 'personal' },
  ]);
});

test('boundary pricing excludes earlier unpriced and future requests, and omits gaps with no requests', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    id: 'boundary',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [{ at: -604_801, model: 'unknown' }, -604_800, 0, { at: 1, model: 'unknown' }],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'gap',
    requests: [-604_801, 1],
    system: 'server-1',
  });
  const result = await view(h);
  expect(result.totals).toEqual({ pricedCostUsd: 2, requests: 2, unpricedRequests: 0 });
  expect(result.sessions.map(({ sessionId }) => sessionId)).toEqual(['boundary']);
  expect(result.sessions[0]?.lastRequestAt).toBe(NOW);
});

test('an entirely unpriced period keeps its Session and a zero priced lower bound', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    id: 'unknown',
    model: 'unknown',
    requests: [-60],
    system: 'server-1',
  });
  expect((await view(h)).totals).toEqual({ pricedCostUsd: 0, requests: 1, unpricedRequests: 1 });
});

test('Sessions being re-derived disappear from both the list and its totals', async () => {
  await using h = await start();
  await addSession(h.db.sql, { id: 'hidden', requests: [-10], system: 'server-1' });
  await h.db.sql`
    INSERT INTO rederiving_sessions (harness, system, source, session_id)
    VALUES ('claude-code', 'server-1', 'claude-code', 'hidden')
  `;
  const result = await view(h);
  expect(result.sessions).toEqual([]);
  expect(result.totals).toEqual({ pricedCostUsd: 0, requests: 0, unpricedRequests: 0 });
});

test.each([
  { from: Date.UTC(2026, 2, 28, 23), now: Date.UTC(2026, 2, 29, 12), timeZone: 'Europe/Berlin' },
  { from: Date.UTC(2026, 9, 24, 22), now: Date.UTC(2026, 9, 25, 12), timeZone: 'Europe/Berlin' },
  { from: Date.UTC(2026, 2, 8, 5), now: Date.UTC(2026, 2, 8, 12), timeZone: 'America/New_York' },
  { from: Date.UTC(2026, 9, 5, 18, 15), now: NOW, timeZone: 'Asia/Kathmandu' },
  { from: Date.UTC(2026, 10, 1, 4), now: Date.UTC(2026, 10, 1, 12), timeZone: 'America/Havana' },
  { from: Date.UTC(2026, 9, 25), now: Date.UTC(2026, 9, 25, 12), timeZone: 'Atlantic/Azores' },
  { from: Date.UTC(2026, 8, 6, 4), now: Date.UTC(2026, 8, 6, 12), timeZone: 'America/Santiago' },
])(
  'Today starts at local midnight across clock changes ($timeZone, $now)',
  async ({ from, now, timeZone }) => {
    await using h = await start();
    await timeline(now).addSession(h.db.sql, {
      id: 'first-hour',
      inputTokens: 1_000_000,
      model: 'test-model',
      outputTokens: 0,
      requests: [(from + 30 * 60_000 - now) / 1000],
      system: 'server-1',
    });
    const result = await readAgentsOverview(h.db.sql, { now, range: 'today', timeZone });
    expect(result.from).toBe(from);
    expect(result.totals).toEqual({ pricedCostUsd: 1, requests: 1, unpricedRequests: 0 });
  },
);

test('a price refresh lag can mix stored and current prices while the total still matches displayed amounts', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    id: 'fits',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-10],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'crosses',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-691_200, -10],
    system: 'server-1',
  });
  await h.db.sql`UPDATE model_prices SET input_per_mtok = 10 WHERE model = 'test-model'`;
  const result = await view(h);
  expect(
    result.sessions.map(({ pricedCostUsd, sessionId }) => ({ pricedCostUsd, sessionId })),
  ).toEqual([
    { pricedCostUsd: 10, sessionId: 'crosses' },
    { pricedCostUsd: 1, sessionId: 'fits' },
  ]);
  expect(result.totals).toEqual({ pricedCostUsd: 11, requests: 2, unpricedRequests: 0 });
});

test.each(['7d', '30d'] as const)(
  'the %s range is a trailing duration even across the database time zone clock change',
  async (range) => {
    await using h = await start();
    const now = Date.UTC(2026, 2, 10, 12);
    const result = await readAgentsOverview(h.db.sql, { now, range, timeZone: 'Europe/Berlin' });
    expect(now - result.from).toBe(range === '7d' ? 604_800_000 : 2_592_000_000);
  },
);

test("a Session's project is the repository of its working directory, else the directory's name", async () => {
  await using h = await start();
  await addProcess(h.db.sql, {
    cwd: '/srv/trees/feature',
    end: -30,
    pid: 10,
    repository: '/srv/work/api',
    start: -400,
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'in-worktree',
    lastCwd: '/srv/trees/feature',
    model: 'test-model',
    requests: [-300, -60],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'unmatched',
    lastCwd: '/srv/trees/other',
    model: 'test-model',
    requests: [-300, -60],
    system: 'server-1',
  });

  const projects = Object.fromEntries(
    (await view(h)).sessions.map((session) => [session.sessionId, session.project]),
  );

  expect(projects).toEqual({ 'in-worktree': 'api', unmatched: 'other' });
});
