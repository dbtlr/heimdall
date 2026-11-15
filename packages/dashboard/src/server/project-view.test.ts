import { beforeAll, expect, test } from 'bun:test';

import { NOW, startHub, timeline } from '@heimdall/hub/testing';

import { agentsPeriod } from './agents-overview.ts';
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
  // 5 minutes after -300 s, cut at now, and 5 after -86,460 s.
  expect(view?.activeMs).toBe(600_000);
  expect(view?.lanes).toHaveLength(2);
  // The process ran 540 s at one core; no CPU between two rollup buckets is lost.
  expect(view?.cpuSeconds).toBe(540);
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

const MINUTE = 60_000;

test('active time is the union of the 5 minutes after each request, clipped to the range', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // No linked process, so one stretch runs from 10 days ago to 50 minutes ago.
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'sparse',
    requests: [-864_000, -3000],
  });
  const week = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(week?.activeMs).toBe(5 * MINUTE);
  const month = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '30d',
    timeZone: 'UTC',
  });
  expect(month?.activeMs).toBe(10 * MINUTE);
  // The lanes draw the same windows.
  expect(month?.lanes.map(({ start, end }) => [start - NOW, end - NOW])).toEqual([
    [-864_000_000, -864_000_000 + 5 * MINUTE],
    [-3_000_000, -3_000_000 + 5 * MINUTE],
  ]);
});

test('overlapping Sessions count their union, and a range never holds more active time than its length', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1'), ('server-1')`;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'a',
    requests: [-3600, -3480, -3360],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'b',
    requests: [-3420, -3300],
    system: 'server-1',
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: 'today',
    timeZone: 'UTC',
  });
  // a runs -60 to -51 min, b -57 to -50 min: together -60 to -50.
  expect(view?.activeMs).toBe(10 * MINUTE);

  await using g = await startHub();
  await g.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  for (const id of ['x', 'y', 'z']) {
    // oxlint-disable-next-line no-await-in-loop -- a few fixture Sessions.
    await addSession(g.db.sql, { firstCwd: '/repos/notes-app', id, requests: [-8 * 86_400, -60] });
  }
  for (const range of ['today', '7d', '30d'] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one read per range.
    const ranged = await readProjectView(g.db.sql, {
      name: 'notes-app',
      now: NOW,
      range,
      timeZone: 'UTC',
    });
    expect(ranged?.activeMs).toBeLessThanOrEqual(NOW - (ranged?.overview.from ?? NOW));
  }
  const week = await readProjectView(g.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  // The last request's window is cut at now.
  expect(week?.activeMs).toBe(MINUTE);
});

test('running counts only the project, and a branch with no request in the range is not listed', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'live',
    id: 'mine',
    requests: [-60],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/other',
    gitBranch: 'theirs',
    id: 'theirs',
    requests: [-30],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'stale',
    id: 'old',
    requests: [-864_000],
  });
  for (const range of ['today', '7d'] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one read per range.
    const view = await readProjectView(h.db.sql, {
      name: 'notes-app',
      now: NOW,
      range,
      timeZone: 'UTC',
    });
    expect(view?.overview.running.map((session) => session.sessionId)).toEqual(['mine']);
    expect(view?.branches).toEqual([{ name: 'live', sessions: 1 }]);
  }
});

test('peak memory is the highest reading in the range, not a process lifetime peak', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  const id = await addProcess(h.db.sql, {
    cpuCores: 1,
    cwd: '/repos/notes-app',
    end: -60,
    pid: 1,
    readings: 'rollups',
    rssBytes: 1024 ** 3,
    start: -600,
  });
  await h.db
    .sql`UPDATE harness_processes SET peak_rss_bytes = ${8 * 1024 ** 3}, started_at = ${new Date(NOW - 10 * 86_400_000)} WHERE id = ${id}`;
  // A reading from before the range holds more.
  await h.db.sql`
    INSERT INTO harness_process_rollups (process, bucket, samples, cpu_micros_min, cpu_micros_max, rss_min, rss_sum, rss_max)
    VALUES (${id}, ${new Date(NOW - 9 * 86_400_000)}, 1, 0, 0, 0, 0, ${4 * 1024 ** 3})
  `;
  await addSession(h.db.sql, { firstCwd: '/repos/notes-app', id: 'one', requests: [-300] });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.peakRssBytes).toBe(1024 ** 3);
  const month = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '30d',
    timeZone: 'UTC',
  });
  expect(month?.peakRssBytes).toBe(4 * 1024 ** 3);
});

test('tool counts cover only the project Sessions active in the range, however many others the archive holds', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1'), ('server-1')`;
  for (const [index, days] of [0, 3, 12, 40].entries()) {
    // oxlint-disable-next-line no-await-in-loop -- a few fixture Sessions.
    await addSession(h.db.sql, {
      firstCwd: '/repos/notes-app',
      id: `mine-${String(index)}`,
      requests: [-days * 86_400 - 120, -days * 86_400 - 60],
      system: index % 2 === 0 ? 'laptop-1' : 'server-1',
      toolCalls: [
        { at: -days * 86_400 - 120, name: 'Edit' },
        { at: -days * 86_400 - 60, name: 'Bash' },
      ],
    });
    // oxlint-disable-next-line no-await-in-loop -- a few fixture Sessions.
    await addSession(h.db.sql, {
      firstCwd: '/repos/other',
      id: `other-${String(index)}`,
      requests: [-days * 86_400 - 60],
      toolCalls: [{ at: -days * 86_400 - 60, name: 'Edit' }],
    });
  }
  const counts = async (range: 'today' | '7d' | '30d') =>
    (
      await readProjectView(h.db.sql, { name: 'notes-app', now: NOW, range, timeZone: 'UTC' })
    )?.tools.map(({ calls, name }) => [name, calls]);
  expect(await counts('today')).toEqual([
    ['Bash', 1],
    ['Edit', 1],
  ]);
  expect(await counts('7d')).toEqual([
    ['Bash', 2],
    ['Edit', 2],
  ]);
  expect(await counts('30d')).toEqual([
    ['Bash', 3],
    ['Edit', 3],
  ]);
});

test('tools with as many calls order by name in code unit order, whatever the database locale', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'one',
    requests: [-60],
    toolCalls: ['explore', 'Read', '_hidden', 'Bash', 'apply'].map((name) => ({ at: -60, name })),
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: 'today',
    timeZone: 'UTC',
  });
  expect(view?.tools.map(({ name }) => name)).toEqual([
    'Bash',
    'Read',
    '_hidden',
    'apply',
    'explore',
  ]);
});

// Seconds from NOW, for fixtures placed relative to the start of a range.
const secondsBeforeRange = (range: '7d' | 'today', seconds: number) =>
  (agentsPeriod({ now: NOW, range, timeZone: 'UTC' }).from.getTime() - NOW) / 1000 - seconds;

test('a Session with no request in the range adds no branch, tool, subagent, lane, or active time', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // Requests 10 days ago and a minute after the range's end, as a skewed clock
  // would write them, with a tool call inside the range between.
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'skewed',
    id: 'skewed',
    requests: [-864_000, 60],
    toolCalls: [{ at: -3000, name: 'Edit' }],
  });
  // Its last request ended 2 minutes before the range began.
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'before',
    id: 'before',
    requests: [secondsBeforeRange('7d', 120)],
    toolCalls: [{ at: -3000, name: 'Bash' }],
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.overview.sessionCount).toBe(0);
  expect(view?.branches).toEqual([]);
  expect(view?.tools).toEqual([]);
  expect(view?.lanes).toEqual([]);
  expect(view?.activeMs).toBe(0);
});

test('a request just before the range adds no lane or active time, while one inside does', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'edge',
    requests: [secondsBeforeRange('7d', 120), secondsBeforeRange('7d', -60)],
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  const from = agentsPeriod({ now: NOW, range: '7d', timeZone: 'UTC' }).from.getTime();
  // Only the request inside the range draws its own 5 minutes.
  expect(view?.lanes.map(({ start, end }) => [start - from, end - from])).toEqual([
    [MINUTE, 6 * MINUTE],
  ]);
  expect(view?.activeMs).toBe(5 * MINUTE);
});

test('peak memory includes the rollup bucket that began before the range and reaches into it', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  const id = await addProcess(h.db.sql, {
    cwd: '/repos/notes-app',
    end: -60,
    pid: 1,
    readings: 'rollups',
    rssBytes: 1024 ** 3,
    start: -600,
  });
  const from = agentsPeriod({ now: NOW, range: '7d', timeZone: 'UTC' }).from.getTime();
  await h.db.sql`
    INSERT INTO harness_process_rollups (process, bucket, samples, cpu_micros_min, cpu_micros_max, rss_min, rss_sum, rss_max)
    VALUES (${id}, ${new Date(from - MINUTE)}, 1, 0, 0, 0, 0, ${4 * 1024 ** 3})
  `;
  await addSession(h.db.sql, { firstCwd: '/repos/notes-app', id: 'one', requests: [-300] });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.peakRssBytes).toBe(4 * 1024 ** 3);
});

const read = (h: { db: { sql: Parameters<typeof readProjectView>[0] } }) =>
  readProjectView(h.db.sql, { name: 'notes-app', now: NOW, range: 'today', timeZone: 'UTC' });

test('the repository flag reads true only when a Session or a process in the project recorded one', async () => {
  await using folder = await startHub();
  await folder.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addSession(folder.db.sql, { firstCwd: '/repos/notes-app', id: 'one', requests: [-60] });
  expect((await read(folder))?.repository).toBe(false);

  // A process outside the range gave the Session its repository.
  await using sessionOnly = await startHub();
  await sessionOnly.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addProcess(sessionOnly.db.sql, {
    cwd: '/work/linked',
    end: -258_000,
    pid: 1,
    repository: '/repos/notes-app',
    start: -259_200,
  });
  await addSession(sessionOnly.db.sql, {
    firstCwd: '/work/linked',
    id: 'linked',
    requests: [-259_000],
  });
  expect((await read(sessionOnly))?.repository).toBe(true);

  // A process in the range, in another folder, names the project; no Session has a repository.
  await using processOnly = await startHub();
  await processOnly.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addProcess(processOnly.db.sql, {
    cwd: '/work/elsewhere',
    end: -60,
    pid: 1,
    repository: '/repos/notes-app',
    start: -600,
  });
  await addSession(processOnly.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'one',
    requests: [-30],
  });
  expect((await read(processOnly))?.repository).toBe(true);
});
