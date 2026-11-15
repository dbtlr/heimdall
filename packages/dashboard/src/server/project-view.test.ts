import { beforeAll, expect, test } from 'bun:test';

import { NOW, startHub, timeline } from '@heimdall/hub/testing';

import { readProjectView } from './project-view.ts';

beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);
const { addSession, addProcess } = timeline(NOW);

test('a project scopes cost, models, Systems, branches and Sessions to its repository folder', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1'), ('server-1')`;
  await h.db
    .sql`INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES ('test-model', '2020-01-01', 'bundled', 1, 2, 200000)`;
  await addProcess(h.db.sql, {
    cpuCores: 1,
    cwd: '/work/topic',
    end: -60,
    pid: 1,
    readings: 'rollups',
    repository: '/repos/notes-app',
    rssBytes: 1073741824,
    start: -600,
    system: 'laptop-1',
  });
  await addSession(h.db.sql, {
    firstCwd: '/work/topic',
    gitBranch: 'topic',
    id: 'one',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-300, -60],
    system: 'laptop-1',
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'main',
    id: 'two',
    inputTokens: 1_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-86460],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/other',
    id: 'other',
    inputTokens: 9_000_000,
    model: 'test-model',
    outputTokens: 0,
    requests: [-60],
    system: 'server-1',
  });
  await h.db
    .sql`UPDATE projected_sessions SET ended_at = ${new Date(NOW)} WHERE session_id = 'one'`;
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view).toBeDefined();
  expect(view?.lastRequestAt).toBe(NOW - 60_000);
  expect(view?.overview.totals).toEqual({ pricedCostUsd: 3, requests: 3, unpricedRequests: 0 });
  expect(view?.overview.breakdown.system).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ key: 'laptop-1', pricedCostUsd: 2 }),
      expect.objectContaining({ key: 'server-1', pricedCostUsd: 1 }),
    ]),
  );
  expect(view?.overview.breakdown.model).toEqual([
    { key: 'test-model', pricedCostUsd: 3, requests: 3, unpricedRequests: 0 },
  ]);
  expect(view?.overview.chart.cells.reduce((sum, cell) => sum + cell.pricedCostUsd, 0)).toBe(3);
  expect(view?.overview.chart.cells.every((cell) => cell.project === 'notes-app')).toBe(true);
  expect(view?.overview.table.sessions.map((session) => session.sessionId).toSorted()).toEqual([
    'one',
    'two',
  ]);
  expect(view?.branches).toEqual([
    { name: 'main', sessions: 1 },
    { name: 'topic', sessions: 1 },
  ]);
  expect(view?.activeMs).toBe(240_000);
  expect(view?.lanes).toHaveLength(2);
  expect(view?.cpuSeconds).toBe(525);
  expect(view?.peakRssBytes).toBe(1073741824);
  expect(view?.overview.chart.cells).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ bucket: 6, pricedCostUsd: 1 }),
      expect.objectContaining({ bucket: 7, pricedCostUsd: 2 }),
    ]),
  );
  expect(
    await readProjectView(h.db.sql, { name: 'unknown', now: NOW, range: 'today', timeZone: 'UTC' }),
  ).toBeUndefined();
  expect(
    await readProjectView(h.db.sql, { name: '', now: NOW, range: 'today', timeZone: 'UTC' }),
  ).toBeUndefined();
});

test('tool and skill counts include subagents, exclude other projects and periods, and never return content', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'tools',
    requests: [-700000, -300, -60],
    subagentRequests: [-120],
    toolCalls: [
      { at: -700000, name: 'Read' },
      { at: -300, name: 'Read' },
      { agentId: 'a1', at: -120, name: 'Read' },
      { at: -60, mcpServer: 'codegraph', name: 'explore' },
      { at: -60, name: 'Skill' },
    ],
  });
  await h.db.sql`UPDATE projected_tool_calls SET skill = 'tdd' WHERE name = 'Skill'`;
  await addSession(h.db.sql, {
    firstCwd: '/repos/other',
    id: 'other',
    requests: [-60],
    toolCalls: [{ at: -60, name: 'Read' }],
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.tools).toEqual([
    { calls: 2, kind: 'tool', mcpServer: null, name: 'Read', skill: null },
    { calls: 1, kind: 'tool', mcpServer: null, name: 'Skill', skill: 'tdd' },
    { calls: 1, kind: 'tool', mcpServer: 'codegraph', name: 'explore', skill: null },
  ]);
  expect(view?.subagents).toBe(1);
  expect(view?.overview.totals.unpricedRequests).toBe(3);
});

test('a known project outside the period stays a page, while no working directory is never a project', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addSession(h.db.sql, { firstCwd: '/repos/notes-app', id: 'old', requests: [-700000] });
  await addSession(h.db.sql, { firstCwd: '/', id: 'missing', requests: [-60] });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: 'today',
    timeZone: 'UTC',
  });
  expect(view?.overview.sessionCount).toBe(0);
  expect(view?.tools).toEqual([]);
  expect(view?.lanes).toEqual([]);
  expect(
    await readProjectView(h.db.sql, { name: '/', now: NOW, range: 'today', timeZone: 'UTC' }),
  ).toBeUndefined();
});
