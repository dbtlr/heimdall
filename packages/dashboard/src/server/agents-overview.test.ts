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
  expect(result.sessions.map(({ pricedCostUsd, source }) => ({ pricedCostUsd, source }))).toEqual([
    { pricedCostUsd: 2, source: 'work' },
    { pricedCostUsd: 1, source: 'personal' },
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

test("a Session resumed into the period spans from its first stretch's request, and one whose last request is the period's start is listed", async () => {
  await using h = await start();
  const DAY_S = 86_400;
  // Two processes in turn run the Session, so its stretch of 10 days ago
  // ends before the period and its second stretch lies inside it.
  await addProcess(h.db.sql, {
    end: -10 * DAY_S + 7200,
    pid: 1,
    start: -10 * DAY_S,
    system: 'server-1',
  });
  await addProcess(h.db.sql, { end: -600, pid: 2, start: -7200, system: 'server-1' });
  await addSession(h.db.sql, {
    id: 'resumed',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-10 * DAY_S + 3600, -3600],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'at-start',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-8 * DAY_S, -7 * DAY_S],
    system: 'laptop-1',
  });
  const [stretches] = await h.db.sql`
    SELECT count(*)::int AS n FROM insight.session_stretches WHERE session_id = 'resumed'
  `;
  expect(stretches).toEqual({ n: 2 });

  const result = await view(h);

  expect(
    result.sessions.map(({ firstRequestAt, lastRequestAt, requests, sessionId }) => ({
      firstRequestAt,
      lastRequestAt,
      requests,
      sessionId,
    })),
  ).toEqual([
    {
      firstRequestAt: NOW - 8 * DAY_S * 1000,
      lastRequestAt: NOW - 7 * DAY_S * 1000,
      requests: 1,
      sessionId: 'at-start',
    },
    {
      firstRequestAt: NOW - (10 * DAY_S - 3600) * 1000,
      lastRequestAt: NOW - 3_600_000,
      requests: 1,
      sessionId: 'resumed',
    },
  ]);
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

test('the 7d range is a trailing duration even across the database time zone clock change', async () => {
  await using h = await start();
  const now = Date.UTC(2026, 2, 10, 12);
  const result = await readAgentsOverview(h.db.sql, {
    now,
    range: '7d',
    timeZone: 'Europe/Berlin',
  });
  expect(now - result.from).toBe(604_800_000);
});

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

test('models are totaled per request in the period, and each Session lists the models it used', async () => {
  await using h = await start();
  await h.db.sql`
    INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES ('pricey-model', '2020-01-01', 'bundled', 4, 8, 2000000)
  `;
  await addSession(h.db.sql, {
    id: 'mixed',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-300, { at: -200, model: 'pricey-model' }, { at: -100, model: 'unknown' }],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'crossing',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [{ at: -700_000, model: 'old-model' }, -50],
    system: 'laptop-1',
  });
  const result = await view(h);
  const byModel = Object.fromEntries(result.models.map(({ model, ...totals }) => [model, totals]));
  expect(byModel).toEqual({
    'pricey-model': { pricedCostUsd: 4, requests: 1, unpricedRequests: 0 },
    'test-model': { pricedCostUsd: 2, requests: 2, unpricedRequests: 0 },
    unknown: { pricedCostUsd: 0, requests: 1, unpricedRequests: 1 },
  });
  const modelsOf = Object.fromEntries(
    result.sessions.map(({ models, sessionId }) => [sessionId, models]),
  );
  expect(modelsOf).toEqual({
    crossing: ['test-model'],
    mixed: ['pricey-model', 'test-model', 'unknown'],
  });
});

test('model totals of a whole Session are the stored ones, and a Session crossing the start is priced by request', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    id: 'whole',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-50, -40],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'crossing',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-691_200, -30],
    system: 'laptop-1',
  });
  await h.db.sql`UPDATE model_prices SET input_per_mtok = 10 WHERE model = 'test-model'`;

  const result = await view(h);
  // The whole Session still has the price stored at the last refresh, as its
  // Session total does; the crossing one is priced now.
  expect(result.models).toEqual([
    { model: 'test-model', pricedCostUsd: 12, requests: 3, unpricedRequests: 0 },
  ]);
  expect(result.totals.pricedCostUsd).toBe(12);
});

test('a request with an empty model totals under the empty model, not under a name', async () => {
  await using h = await start();
  await addSession(h.db.sql, { id: 'blank', model: '', requests: [-50, -40], system: 'server-1' });

  const result = await view(h);

  expect(result.models).toEqual([
    { model: '', pricedCostUsd: 0, requests: 2, unpricedRequests: 2 },
  ]);
  expect(result.sessions[0]?.models).toEqual(['']);
});

test('stored model totals of a Session the period lists no longer are not counted', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    harness: 'codex',
    id: 'kept',
    model: 'test-model',
    requests: [-50],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'switched',
    model: 'old-model',
    requests: [-60, -40],
    system: 'server-1',
  });
  // A newer parser leaves the Session unlisted until its requests are parsed
  // again, while its stored model totals stay until the refresh.
  await h.db.sql`UPDATE current_parsers SET version = version + 1 WHERE harness = 'claude-code'`;

  const result = await view(h);

  expect(result.sessions.map((one) => one.sessionId)).toEqual(['kept']);
  expect(result.models.map((one) => one.model)).toEqual(['test-model']);
  expect(result.models.reduce((sum, one) => sum + one.requests, 0)).toBe(result.totals.requests);
});

// The database orders model ids by its locale (a-model before B-model); the
// list is sorted by code unit, as it is wherever it is read.
test("a Session's models are listed in code unit order, not in the order the database returns them", async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    id: 'mixed',
    model: 'a-model',
    requests: [-300, { at: -200, model: 'B-model' }, { at: -100, model: 'c-model' }],
    system: 'server-1',
  });

  const result = await view(h);

  expect(result.sessions[0]?.models).toEqual(['B-model', 'a-model', 'c-model']);
});

// The database orders a-model before B-model by its locale; the tie goes to
// the model first in code unit order, B-model, wherever the Session is read.
test("a Session's top model is the one with the most requests, the first in code unit order on a tie", async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    id: 'tied',
    model: 'a-model',
    requests: [
      -500,
      { at: -400, model: 'B-model' },
      -300,
      { at: -200, model: 'B-model' },
      { at: -100, model: 'c-model' },
    ],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'leading',
    model: 'z-model',
    requests: [-450, -350, { at: -250, model: 'B-model' }],
    system: 'laptop-1',
  });

  const result = await view(h);

  const topOf = Object.fromEntries(
    result.sessions.map(({ sessionId, topModel }) => [sessionId, topModel]),
  );
  expect(topOf).toEqual({ leading: 'z-model', tied: 'B-model' });
});
