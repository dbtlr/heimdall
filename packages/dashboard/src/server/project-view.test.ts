import { beforeAll, expect, test } from 'bun:test';

import { NOW, refreshSessionInsight, startHub, timeline } from '@heimdall/hub/testing';
import { SQL } from 'bun';

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

test("tool counts take a Session's stored counts, and its calls when a tool crosses the range's edge or it is stale", async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  const session = (id: string, requests: number[], toolCalls: { at: number; name: string }[]) =>
    addSession(h.db.sql, { firstCwd: '/repos/notes-app', id, requests, toolCalls });
  await session(
    'inside',
    [-3600, -1800],
    [
      { at: -3600, name: 'Read' },
      { at: -1800, name: 'Read' },
    ],
  );
  await session(
    'crossing',
    [-8 * 86_400, -600],
    [
      { at: -8 * 86_400, name: 'Edit' },
      { at: -600, name: 'Edit' },
    ],
  );
  await session('stale', [-1200], [{ at: -1200, name: 'Bash' }]);
  // A stored count the read takes shows as altered here.
  await h.db.sql`UPDATE stored_session_tool_totals SET calls = 9`;
  await h.db.sql`
    INSERT INTO stale_sessions (harness, system, source, session_id, stretches, totals)
    SELECT harness, system, source, session_id, false, true FROM projected_sessions
    WHERE session_id = 'stale'
  `;
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.tools.map(({ calls, name }) => [name, calls])).toEqual([
    ['Read', 9],
    ['Bash', 1],
    ['Edit', 1],
  ]);
  expect(view?.toolCount).toBe(3);
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
  expect(view?.subagents).toBe(0);
  expect(view?.lanes).toEqual([]);
  expect(view?.activeMs).toBe(0);
});

test('a subagent counts only with a request in the range, even in a Session that has one', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'live',
    requests: [-600],
    subagents: [
      { agentId: 'skewed', requests: [-864_000, 60] },
      { agentId: 'working', requests: [-590] },
    ],
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.overview.sessionCount).toBe(1);
  expect(view?.subagents).toBe(1);
});

test('requests around a period shorter than 5 minutes add only those inside it, for a lane, a subagent, and a Session', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // Local midnight is NOW, so Today runs 2 minutes, to NOW + 120 seconds. The
  // subagent's requests, 290 seconds apart, fall on either side of it, and so
  // do the second Session's, 260 seconds apart.
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'inside',
    id: 'midnight',
    requests: [-60, 60],
    subagents: [{ agentId: 'around', requests: [-40, 250] }],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'around',
    id: 'around',
    requests: [-60, 200],
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW + 120_000,
    range: 'today',
    timeZone: 'Etc/GMT-12',
  });
  expect(view?.lanes.map(({ start, end }) => [start - NOW, end - NOW])).toEqual([
    [60_000, 120_000],
  ]);
  expect(view?.activeMs).toBe(60_000);
  expect(view?.subagents).toBe(0);
  expect(view?.branches).toEqual([{ name: 'inside', sessions: 1 }]);
});

test("process CPU is each process's own span over the buckets that overlap the range, summed", async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // The range starts 4 minutes into a 5-minute rollup bucket.
  const now = NOW + 240_000;
  const from = (agentsPeriod({ now, range: '7d', timeZone: 'UTC' }).from.getTime() - NOW) / 1000;
  await addSession(h.db.sql, { firstCwd: '/repos/notes-app', id: 'live', requests: [-600] });
  // One core from 20 minutes before the range to 10 minutes into it: its buckets
  // that overlap the range start 4 minutes before it, so 14 minutes count.
  await addProcess(h.db.sql, {
    cpuCores: 1,
    cwd: '/repos/notes-app',
    end: from + 600,
    pid: 1,
    readings: 'rollups',
    start: from - 1200,
  });
  // Two cores for 9 minutes inside the range.
  await addProcess(h.db.sql, {
    cpuCores: 2,
    cwd: '/repos/notes-app',
    end: from + 600,
    pid: 2,
    readings: 'rollups',
    start: from + 60,
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.cpuSeconds).toBe(840 + 1080);
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

// The totals of `n` requests that cost a dollar each.
const dollars = (n: number) => ({ pricedCostUsd: n, requests: n, unpricedRequests: 0 });

test("the project's cost by role covers exactly its Sessions in the page's period and sums to its cost", async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1'), ('server-1')`;
  await h.db
    .sql`INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES ('test-model', '2020-01-01', 'bundled', 1, 2, 2000000)`;
  const dollar = { inputTokens: 1_000_000, model: 'test-model', outputTokens: 0 };
  // Wholly inside the period: its main conversation, a breaker, and a helper.
  await addSession(h.db.sql, {
    ...dollar,
    firstCwd: '/repos/notes-app',
    id: 'orchestrator',
    requests: [-7200, -3600],
    subagents: [
      { agentId: 'breaker', requests: [-7000, -6900] },
      { agentId: 'helper', requests: [-6000] },
    ],
  });
  // Crossing the 7-day edge: only its request inside the period counts.
  await addSession(h.db.sql, {
    ...dollar,
    firstCwd: '/repos/notes-app',
    id: 'reviewer',
    requests: [-8 * 86_400, -1800],
    system: 'server-1',
  });
  // A request stamped after now, inside the clock tolerance the Agents page
  // allows: the project page's period ends at now, so it counts in neither.
  await addSession(h.db.sql, {
    ...dollar,
    firstCwd: '/repos/notes-app',
    id: 'ahead',
    requests: [-900, 60],
  });
  // Another project's reviewer, inside the period.
  await addSession(h.db.sql, {
    ...dollar,
    firstCwd: '/repos/other',
    id: 'elsewhere',
    requests: [-600],
  });
  const role = (session: string, value: string, seat: string | null, agent?: string) =>
    agent === undefined
      ? h.db.sql`UPDATE projected_sessions SET role = ${value}, seat = ${seat}, role_source = 'tag'
          WHERE session_id = ${session}`
      : h.db.sql`UPDATE projected_subagents SET role = ${value}, seat = ${seat}, role_source = 'tag'
          WHERE session_id = ${session} AND agent_id = ${agent}`;
  await role('orchestrator', 'review', 'breaker', 'breaker');
  await role('reviewer', 'review', 'verifier');
  await role('elsewhere', 'review', 'architect');
  await refreshSessionInsight(h.db.sql, { budgetMs: Number.POSITIVE_INFINITY });

  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });

  expect(view?.roleSplit.classes).toEqual({
    delegated: dollars(1),
    main: dollars(3),
    review: dollars(3),
  });
  expect(
    view?.roleSplit.seats.toSorted((a, b) => (a.seat ?? '').localeCompare(b.seat ?? '')),
  ).toEqual([
    { seat: 'breaker', ...dollars(2) },
    { seat: 'verifier', ...dollars(1) },
  ]);
  expect(view?.overview.totals).toEqual(dollars(7));
});

// A lane as seconds from NOW: its Session, start, and end.
const laneSeconds = (lanes: { end: number; sessionId: string; start: number }[] = []) =>
  lanes.map(({ end, sessionId, start }) => [sessionId, (start - NOW) / 1000, (end - NOW) / 1000]);

test('a request exactly at either edge of the range counts, for a lane, a subagent, and a Session', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // Seven days to NOW + 1000 seconds: the range runs from F + 1000 to 1000.
  const F = -7 * 86_400;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'endsAtFrom',
    id: 'e',
    requests: [F + 900, F + 1000],
    subagents: [{ agentId: 'x', requests: [F + 1000] }],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'crossesFrom',
    id: 'c',
    requests: [F + 900, F + 1000, F + 1100],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'startsAtTo',
    id: 't',
    requests: [1000],
    subagents: [{ agentId: 'y', requests: [1000] }],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'crossesTo',
    id: 'u',
    requests: [900, 1000, 1100],
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW + 1_000_000,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(laneSeconds(view?.lanes)).toEqual([
    ['c', F + 1000, F + 1400],
    ['e', F + 1000, F + 1300],
    ['u', 900, 1000],
    ['t', 1000, 1000],
  ]);
  expect(view?.activeMs).toBe(500_000);
  expect(view?.subagents).toBe(2);
  expect(view?.branches.map((branch) => branch.name).toSorted()).toEqual([
    'crossesFrom',
    'crossesTo',
    'endsAtFrom',
    'startsAtTo',
  ]);
});

test('a burst reaching past the range draws its lane from its first request inside to the range end', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // Seven days to NOW + 1000 seconds: the range ends at 1000.
  await addSession(h.db.sql, { firstCwd: '/repos/notes-app', id: 'p', requests: [940, 1120] });
  await addSession(h.db.sql, { firstCwd: '/repos/notes-app', id: 'q', requests: [1000, 1100] });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW + 1_000_000,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(laneSeconds(view?.lanes)).toEqual([
    ['p', 940, 1000],
    ['q', 1000, 1000],
  ]);
});

test('requests exactly at the edges of a period shorter than 5 minutes count, for a Session and a subagent', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // Local midnight is NOW, so Today runs 2 minutes, from NOW to NOW + 120
  // seconds. Each burst crosses both edges with one request exactly on an edge.
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'atFrom',
    id: 'f',
    requests: [-60, 0, 200],
    subagents: [{ agentId: 'sf', requests: [-60, 0, 200] }],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'atTo',
    id: 't',
    requests: [-60, 120, 300],
    subagents: [{ agentId: 'st', requests: [-60, 120, 300] }],
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW + 120_000,
    range: 'today',
    timeZone: 'Etc/GMT-12',
  });
  expect(view?.branches.map((branch) => branch.name).toSorted()).toEqual(['atFrom', 'atTo']);
  expect(view?.subagents).toBe(2);
});

test('a tool call exactly at either edge of the range counts, stored or read live', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // Seven days to NOW + 1000 seconds: the range runs from F + 1000 to 1000.
  const F = -7 * 86_400;
  // Each Session's one tool crosses an edge, its call on the edge, so the
  // Session's calls are counted live.
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'crossesFrom',
    requests: [F + 900, F + 1000],
    toolCalls: [
      { at: F + 900, name: 'Edit' },
      { at: F + 1000, name: 'Edit' },
    ],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'crossesTo',
    requests: [1000, 1100],
    toolCalls: [
      { at: 1000, name: 'Bash' },
      { at: 1100, name: 'Bash' },
    ],
  });
  // No tool crosses an edge, so the stored counts serve.
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'inside',
    requests: [F + 1000, 500, 1000],
    toolCalls: [
      { at: F + 1000, name: 'Read' },
      { at: 500, name: 'Read' },
      { at: 500, name: 'Grep' },
      { at: 1000, name: 'Grep' },
    ],
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW + 1_000_000,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.tools.map(({ calls, name }) => [name, calls])).toEqual([
    ['Grep', 2],
    ['Read', 2],
    ['Bash', 1],
    ['Edit', 1],
  ]);
});

test('tool counts read live while a stale range covers the System', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'ranged',
    requests: [-1200],
    toolCalls: [{ at: -1200, name: 'Read' }],
  });
  // A stored count the read takes shows as altered here.
  await h.db.sql`UPDATE stored_session_tool_totals SET calls = 9`;
  await h.db.sql`
    INSERT INTO stale_ranges (system, harness, stretches, totals) VALUES ('laptop-1', NULL, false, true)
  `;
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.tools.map(({ calls, name }) => [name, calls])).toEqual([['Read', 1]]);
});

test('a subagent whose requests fall before, inside, and after a period shorter than 5 minutes counts', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // Local midnight is NOW, so Today runs 2 minutes, to NOW + 120 seconds.
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'm',
    requests: [-60, 60, 200],
    subagents: [{ agentId: 's', requests: [-60, 60, 200] }],
  });
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW + 120_000,
    range: 'today',
    timeZone: 'Etc/GMT-12',
  });
  expect(laneSeconds(view?.lanes)).toEqual([['m', 60, 120]]);
  expect(view?.activeMs).toBe(60_000);
  expect(view?.subagents).toBe(1);
});

test('a burst whose requests moved since the refresh draws no lane across the edge it crosses', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  // Seven days to NOW + 1000 seconds: the range runs from F + 1000 to 1000.
  const F = -7 * 86_400;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'early',
    requests: [F + 900, F + 1010],
  });
  await addSession(h.db.sql, { firstCwd: '/repos/notes-app', id: 'late', requests: [990, 1100] });
  // Each burst's only request inside the range moves elsewhere inside it, and
  // the Sessions wait for their next refresh.
  await h.db.sql`UPDATE projected_requests SET at = ${new Date(NOW + (F + 3000) * 1000)}
    WHERE request_id = 'early-1'`;
  await h.db.sql`UPDATE projected_requests SET at = ${new Date(NOW + 500_000)}
    WHERE request_id = 'late-0'`;
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW + 1_000_000,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.lanes).toEqual([]);
  expect(view?.activeMs).toBe(0);
});

test('the 30-day read takes one connection, so it finishes while the pool’s other connections are held', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'one-connection',
    requests: [-3600],
    toolCalls: [{ at: -3600, name: 'Read' }],
  });
  const pool = new SQL(h.db.url, { max: 3 });
  // Two of the pool's three connections are held elsewhere, so a read that
  // took a second would wait for one of them.
  const busy = await pool.reserve();
  const reserved = await pool.reserve();
  try {
    const view = await Promise.race([
      readProjectView(pool, { name: 'notes-app', now: NOW, range: '30d', timeZone: 'UTC' }),
      Bun.sleep(5000).then(() => 'waited' as const),
    ]);
    expect(view === 'waited' ? view : view?.tools.map(({ calls }) => calls)).toEqual([1]);
  } finally {
    await reserved.release();
    await busy.release();
    await pool.close();
  }
});

test('a Session with stretches but no stored totals adds no branch and no tools, as the bursts give none', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  const D = 86_400;
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'main',
    id: 'totaled',
    requests: [-2 * D, -2 * D + 60],
    toolCalls: [{ at: -2 * D, name: 'Totaled' }],
  });
  await addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    gitBranch: 'untotaled-branch',
    id: 'untotaled',
    requests: [-4 * D, -4 * D + 60],
    toolCalls: [{ at: -4 * D, name: 'Untotaled' }],
  });
  await h.db.sql`DELETE FROM stored_session_totals WHERE session_id = 'untotaled'`;
  const view = await readProjectView(h.db.sql, {
    name: 'notes-app',
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });
  expect(view?.branches.map(({ name }) => name)).toEqual(['main']);
  expect(view?.tools.map(({ name }) => name)).toEqual(['Totaled']);
});
