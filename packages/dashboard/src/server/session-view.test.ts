import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { bucketFor, parseSessionInput, readSessionView } from './session-view.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Seconds after NOW, as the Hub's fixtures take them.
const { addProcess, addSession, addVitals } = timeline(NOW);

const KEY = { harness: 'claude-code', sessionId: 's1', source: 'claude-code', system: 'server-1' };

// Sends one Report from server-1 as the Hub receives it at NOW, with a sample
// every 15 seconds from `from` until before `to`, in seconds after NOW.
const hear = async (h: Hub, from: number, to: number) => {
  h.clock.now = NOW;
  const times = Array.from(
    { length: Math.floor((to - from) / 15) },
    (_, i) => NOW + (from + i * 15) * SECOND,
  );
  const response = await push(h.hub, report('server-1', times), { token: 'server-token' });
  expect(response.status).toBe(200);
};

// A model with a price for every kind of token, in dollars per million tokens.
const price = (h: Hub) => h.db.sql`
  INSERT INTO model_prices (
    model, valid_from, source, input_per_mtok, output_per_mtok, cache_read_per_mtok,
    cache_write_5m_per_mtok, cache_write_1h_per_mtok, context_window
  )
  VALUES ('priced-model', '2020-01-01', 'bundled', 4, 20, 0.5, 5, 10, 200000)
`;

// A Hub whose Systems have sent a Report, as the fixtures need.
const start = async () => {
  const h = await startHub();
  await h.db.sql`
    INSERT INTO systems (name, last_seen_at) VALUES ('server-1', now()), ('laptop-1', now())
    ON CONFLICT DO NOTHING
  `;
  return h;
};

const view = async (h: Hub, key: Partial<typeof KEY> = {}) => {
  const found = await readSessionView(h.db.sql, { ...KEY, ...key });
  if (found === undefined) {
    throw new Error('no Session view');
  }
  return found;
};

describe('parseSessionInput', () => {
  test('takes the four parts of a Session key', () => {
    expect(parseSessionInput({ ...KEY })).toEqual(KEY);
  });

  test('names the part that is missing or empty', () => {
    expect(() => parseSessionInput({ ...KEY, system: undefined })).toThrow('system');
    expect(() => parseSessionInput({ ...KEY, sessionId: '' })).toThrow('sessionId');
    expect(() => parseSessionInput(undefined)).toThrow('harness');
  });
});

describe('bucketFor', () => {
  test('widens with the span, to 1 hour by 90 hours', () => {
    expect(bucketFor(0)).toBe(MINUTE);
    expect(bucketFor(90 * MINUTE)).toBe(MINUTE);
    expect(bucketFor(91 * MINUTE)).toBe(2 * MINUTE);
    expect(bucketFor(3 * HOUR)).toBe(2 * MINUTE);
    expect(bucketFor(3 * HOUR + MINUTE)).toBe(5 * MINUTE);
    expect(bucketFor(15 * HOUR)).toBe(10 * MINUTE);
    expect(bucketFor(45 * HOUR)).toBe(30 * MINUTE);
    expect(bucketFor(90 * HOUR)).toBe(HOUR);
  });

  test('grows through hours that divide a day, then whole days, so every bucket starts on the page grid', () => {
    expect(bucketFor(90 * HOUR + MINUTE)).toBe(2 * HOUR);
    expect(bucketFor(200 * HOUR)).toBe(3 * HOUR);
    expect(bucketFor(400 * HOUR)).toBe(6 * HOUR);
    expect(bucketFor(1500 * HOUR)).toBe(24 * HOUR);
    expect(bucketFor(2200 * HOUR)).toBe(48 * HOUR);
  });
});

// Process 10 ran the Session's first stretch alone; processes 20 and 21,
// which share its working directory, ran the second, so that one is ambiguous.
const stretchScene = async (h: Hub) => {
  await hear(h, -10_800, 0);
  await addProcess(h.db.sql, {
    cpuCores: 2,
    cwd: '/srv/work/api',
    end: -5000,
    pid: 10,
    start: -9000,
    system: 'server-1',
  });
  for (const pid of [20, 21]) {
    // oxlint-disable-next-line no-await-in-loop -- two fixture rows.
    await addProcess(h.db.sql, {
      cpuCores: 1,
      cwd: '/srv/work/api',
      end: -1000,
      pid,
      start: -4000,
      system: 'server-1',
    });
  }
  await addSession(h.db.sql, {
    id: 's1',
    lastCwd: '/srv/work/api',
    requests: [-8500, -8000, -3500, -3000],
    system: 'server-1',
  });
};

describe('readSessionView', () => {
  test('answers nothing for a Session the Hub does not hold', async () => {
    await using h = await start();
    await addSession(h.db.sql, { id: 's1', requests: [-600, -300], system: 'server-1' });

    expect(await readSessionView(h.db.sql, { ...KEY, sessionId: 'nobody' })).toBeUndefined();
    expect(await readSessionView(h.db.sql, { ...KEY, source: 'other' })).toBeUndefined();
  });

  test('carries the Session identity, its place, and the span of its requests', async () => {
    await using h = await start();
    await addSession(h.db.sql, {
      firstCwd: '/srv/work/old',
      gitBranch: 'feature/view',
      harnessVersion: '2.4.1',
      id: 's1',
      lastCwd: '/srv/work/api',
      requests: [-600, -300],
      source: 'claude-code',
      system: 'server-1',
    });

    expect(await view(h)).toMatchObject({
      ...KEY,
      branch: 'feature/view',
      cwd: '/srv/work/api',
      endedAt: NOW - 300 * SECOND,
      harnessVersion: '2.4.1',
      startedAt: NOW - 600 * SECOND,
    });
  });

  test('lists requests oldest first with their cost by kind of token and whether they were interrupted', async () => {
    await using h = await start();
    await price(h);
    await addSession(h.db.sql, {
      id: 's1',
      model: 'priced-model',
      requests: [
        { at: -300, inputTokens: 1_000_000, outputTokens: 0, stopReason: 'end_turn' },
        {
          at: -600,
          cacheReadTokens: 2_000_000,
          cacheWriteTokens: 1_000_000,
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          skill: 'review',
          stopReason: null,
        },
      ],
      system: 'server-1',
    });

    const { requests, totals } = await view(h);

    expect(requests.map(({ requestId }) => requestId)).toEqual(['s1-1', 's1-0']);
    expect(requests[0]).toMatchObject({
      agentId: undefined,
      at: NOW - 600 * SECOND,
      cacheReadCostUsd: 1,
      cacheReadTokens: 2_000_000,
      cacheWriteCostUsd: 5,
      cacheWriteTokens: 1_000_000,
      contextTokens: 4_000_000,
      contextWindow: 200_000,
      costUsd: 20,
      inputCostUsd: 4,
      inputTokens: 1_000_000,
      interrupted: true,
      model: 'priced-model',
      outputCostUsd: 10,
      outputTokens: 500_000,
      skill: 'review',
      stopReason: undefined,
    });
    expect(requests[1]).toMatchObject({ costUsd: 4, interrupted: false, stopReason: 'end_turn' });
    expect(totals).toMatchObject({
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 1_000_000,
      costUsd: 24,
      inputTokens: 2_000_000,
      mainRequests: 2,
      outputTokens: 500_000,
      pricedCostUsd: 24,
      requests: 2,
      unpricedRequests: 0,
    });
  });

  test('has no cost for a request of an unpriced model, and no total, but sums the priced ones', async () => {
    await using h = await start();
    await price(h);
    await addSession(h.db.sql, {
      id: 's1',
      requests: [
        { at: -600, inputTokens: 1_000_000, model: 'priced-model', outputTokens: 0 },
        { at: -300, model: 'mystery-model' },
      ],
      system: 'server-1',
    });

    const { requests, totals } = await view(h);

    expect(requests[1]).toMatchObject({
      cacheReadCostUsd: undefined,
      cacheWriteCostUsd: undefined,
      costUsd: undefined,
      inputCostUsd: undefined,
      outputCostUsd: undefined,
    });
    expect(totals).toMatchObject({ costUsd: undefined, pricedCostUsd: 4, unpricedRequests: 1 });
  });

  test('lists the subagents with their depth, parent, and workflow, and marks their requests', async () => {
    await using h = await start();
    await addSession(h.db.sql, {
      id: 's1',
      requests: [-900, -100],
      subagents: [
        { agentId: 'a1', agentType: 'Explore', depth: 1, requests: [-800, -700] },
        { agentId: 'a2', depth: 2, parentAgentId: 'a1', requests: [-750] },
        {
          agentId: 'w1',
          depth: 1,
          requests: [-500, -400],
          workflowPhase: 'review',
          workflowRun: 'run-7',
        },
      ],
      system: 'server-1',
    });

    const { agents, requests, totals } = await view(h);

    expect(agents).toEqual([
      {
        agentId: 'a1',
        agentType: 'Explore',
        depth: 1,
        endedAt: NOW - 700 * SECOND,
        parentAgentId: undefined,
        startedAt: NOW - 800 * SECOND,
        workflowPhase: undefined,
        workflowRun: undefined,
      },
      {
        agentId: 'a2',
        agentType: undefined,
        depth: 2,
        endedAt: NOW - 750 * SECOND,
        parentAgentId: 'a1',
        startedAt: NOW - 750 * SECOND,
        workflowPhase: undefined,
        workflowRun: undefined,
      },
      {
        agentId: 'w1',
        agentType: undefined,
        depth: 1,
        endedAt: NOW - 400 * SECOND,
        parentAgentId: undefined,
        startedAt: NOW - 500 * SECOND,
        workflowPhase: 'review',
        workflowRun: 'run-7',
      },
    ]);
    expect(requests.map(({ agentId }) => agentId)).toEqual([
      undefined,
      'a1',
      'a2',
      'a1',
      'w1',
      'w1',
      undefined,
    ]);
    expect(totals).toMatchObject({ mainRequests: 2, requests: 7 });
  });

  test('lists tool calls with the request that made them, and commands, which have none', async () => {
    await using h = await start();
    await addSession(h.db.sql, {
      id: 's1',
      requests: [-900, -600],
      subagents: [{ agentId: 'a1', depth: 1, requests: [-800] }],
      system: 'server-1',
      toolCalls: [
        { at: -590, kind: 'tool', name: 'Bash', requestIndex: 1 },
        { at: -950, kind: 'command', name: '/review' },
        { agentId: 'a1', at: -790, mcpServer: 'github', name: 'search', requestIndex: 0 },
      ],
    });

    const { toolCalls } = await view(h);

    expect(toolCalls).toEqual([
      {
        agentId: undefined,
        at: NOW - 950 * SECOND,
        callId: 's1-call-1',
        kind: 'command',
        mcpServer: undefined,
        name: '/review',
        requestId: undefined,
      },
      {
        agentId: 'a1',
        at: NOW - 790 * SECOND,
        callId: 's1-call-2',
        kind: 'tool',
        mcpServer: 'github',
        name: 'search',
        requestId: 's1-a1-0',
      },
      {
        agentId: undefined,
        at: NOW - 590 * SECOND,
        callId: 's1-call-0',
        kind: 'tool',
        mcpServer: undefined,
        name: 'Bash',
        requestId: 's1-1',
      },
    ]);
  });

  test('lists the stretches with the process the first links to and the candidates of the second', async () => {
    await using h = await start();
    await stretchScene(h);

    const { stretches } = await view(h);

    expect(stretches).toEqual([
      {
        candidates: 1,
        endedAt: NOW - 8000 * SECOND,
        link: 'linked',
        pid: 10,
        processId: expect.any(Number),
        requests: 2,
        startedAt: NOW - 8500 * SECOND,
      },
      {
        candidates: 2,
        endedAt: NOW - 3000 * SECOND,
        link: 'ambiguous',
        pid: undefined,
        processId: undefined,
        requests: 2,
        startedAt: NOW - 3500 * SECOND,
      },
    ]);
  });

  test('gives the cores of the process a stretch is linked to, and none for a candidate', async () => {
    await using h = await start();
    await stretchScene(h);

    const { bucketMs, processes } = await view(h);

    expect(bucketMs).toBe(2 * MINUTE);
    expect(processes).toHaveLength(1);
    expect(processes[0]).toMatchObject({ harness: 'claude-code', pid: 10, project: 'api' });
    const points = processes[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(10);
    expect(points[1]?.t).toBe((points[0]?.t ?? 0) + 2 * MINUTE);
    expect(points[1]?.cores).toBeCloseTo(2, 5);
  });

  test('names the Session and its process by the repository their working directory belongs to, and keeps the directory', async () => {
    await using h = await start();
    await hear(h, -10_800, 0);
    await addProcess(h.db.sql, {
      cpuCores: 2,
      cwd: '/srv/trees/feature',
      end: -5000,
      pid: 10,
      repository: '/srv/work/api',
      start: -9000,
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      id: 's1',
      lastCwd: '/srv/trees/feature',
      requests: [-8500, -8000],
      system: 'server-1',
    });

    const found = await view(h);

    expect(found).toMatchObject({ cwd: '/srv/trees/feature', project: 'api' });
    expect(found.processes.map(({ project }) => project)).toEqual(['api']);
  });

  test('names a Session outside any matched repository by its working directory', async () => {
    await using h = await start();
    await addSession(h.db.sql, {
      id: 's1',
      lastCwd: '/srv/work/notes',
      requests: [-600, -300],
      system: 'server-1',
    });

    expect((await view(h)).project).toBe('notes');
  });

  test('draws no cores for a process with only rollups when the raw Vitals need buckets narrower than 5 minutes', async () => {
    await using h = await start();
    await hear(h, -10_800, 0);
    await addProcess(h.db.sql, {
      cpuCores: 2,
      cwd: '/srv/work/api',
      end: -5000,
      pid: 10,
      readings: 'rollups',
      start: -9000,
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      id: 's1',
      lastCwd: '/srv/work/api',
      requests: [-8500, -8000],
      system: 'server-1',
    });

    const { processes } = await view(h);

    expect(processes).toEqual([]);
  });

  test('averages the System CPU over the span in buckets as wide as the span needs', async () => {
    await using h = await start();
    // 60-minute span: 1-minute buckets. Samples in the first minute are 10 and
    // 30, and in the second 50.
    await addVitals(h.db.sql, 'server-1', -3600, 10);
    await addVitals(h.db.sql, 'server-1', -3590, 30);
    await addVitals(h.db.sql, 'server-1', -3540, 50);
    await addVitals(h.db.sql, 'server-1', -30, 70);
    await addSession(h.db.sql, { id: 's1', requests: [-3600, -30], system: 'server-1' });

    const { bucketMs, cpu } = await view(h);

    expect(bucketMs).toBe(MINUTE);
    expect(cpu).toEqual([
      { average: 20, high: 30, low: 10, t: NOW - 3600 * SECOND },
      { average: 50, high: 50, low: 50, t: NOW - 3540 * SECOND },
      { average: 70, high: 70, low: 70, t: NOW - 60 * SECOND },
    ]);
  });

  test('falls back to the 5-minute rollups once the raw samples are pruned', async () => {
    await using h = await start();
    await addVitals(h.db.sql, 'server-1', -3600, 10);
    await addVitals(h.db.sql, 'server-1', -3590, 30);
    await addVitals(h.db.sql, 'server-1', -30, 70);
    await h.db.sql`DELETE FROM vitals_samples`;
    await addSession(h.db.sql, { id: 's1', requests: [-3600, -30], system: 'server-1' });

    const { bucketMs, cpu } = await view(h);

    expect(bucketMs).toBe(5 * MINUTE);
    expect(cpu).toEqual([
      { average: 20, high: 30, low: 10, t: NOW - 3600 * SECOND },
      { average: 70, high: 70, low: 70, t: NOW - 300 * SECOND },
    ]);
  });

  test('reads only Vitals of the Session System', async () => {
    await using h = await start();
    await addVitals(h.db.sql, 'laptop-1', -3600, 99);
    await addSession(h.db.sql, { id: 's1', requests: [-3600, -30], system: 'server-1' });

    expect((await view(h)).cpu).toEqual([]);
  });

  test('starts every CPU bucket and process point of a long Session on the epoch grid the page draws', async () => {
    await using h = await start();
    // 100 days: buckets of 2 days, which the Hub's 2000-01-01 origin would put a day out of step.
    for (const day of [100, 50, 1]) {
      // oxlint-disable-next-line no-await-in-loop -- three fixture rows.
      await addVitals(h.db.sql, 'server-1', -day * 86_400, 40);
    }
    await addProcess(h.db.sql, {
      cpuCores: 1,
      cwd: '/srv/work/api',
      end: -50 * 86_400 + 7200,
      pid: 10,
      readings: 'both',
      seenFrom: -50 * 86_400,
      seenTo: -50 * 86_400 + 3600,
      start: -50 * 86_400 - 3600,
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      id: 's1',
      lastCwd: '/srv/work/api',
      requests: [-100 * 86_400, -50 * 86_400 + 600, -50 * 86_400 + 1200, -1],
      system: 'server-1',
    });

    const { bucketMs, cpu, processes } = await view(h);

    expect(bucketMs).toBe(2 * DAY);
    expect(cpu.length).toBeGreaterThan(1);
    expect(processes).toHaveLength(1);
    const times = [...cpu.map(({ t }) => t), ...(processes[0]?.points.map(({ t }) => t) ?? [])];
    expect(times.length).toBeGreaterThan(2);
    for (const t of times) {
      expect(t % bucketMs).toBe(0);
    }
  });

  test('reads the rollups for the whole Session when its first bucket is older than the oldest raw sample', async () => {
    await using h = await start();
    await addVitals(h.db.sql, 'server-1', -7200, 10);
    await addVitals(h.db.sql, 'server-1', -3600, 30);
    await addVitals(h.db.sql, 'server-1', -60, 50);
    await h.db.sql`DELETE FROM vitals_samples WHERE t < ${new Date(NOW - 3000 * SECOND)}`;
    await addSession(h.db.sql, { id: 's1', requests: [-7200, -60], system: 'server-1' });

    const { bucketMs, cpu } = await view(h);

    expect(bucketMs).toBe(5 * MINUTE);
    expect(cpu.map(({ average, t }) => [t, average])).toEqual([
      [NOW - 7200 * SECOND, 10],
      [NOW - 3600 * SECOND, 30],
      [NOW - 300 * SECOND, 50],
    ]);
  });

  test('bins the rollups of a long Session to the width that keeps it within 90 buckets', async () => {
    await using h = await start();
    // The first hour's 12 rollups, then one at the end of the Session.
    for (const t of [...Array.from({ length: 12 }, (_, i) => -3 * 86_400 + i * 300), 0]) {
      // oxlint-disable-next-line no-await-in-loop -- 13 fixture rows, in order.
      await addVitals(h.db.sql, 'server-1', t, t === -3 * 86_400 ? 10 : 20);
    }
    await h.db.sql`DELETE FROM vitals_samples`;
    await addSession(h.db.sql, { id: 's1', requests: [-3 * 86_400, 0], system: 'server-1' });

    const { bucketMs, cpu } = await view(h);

    expect(bucketMs).toBe(HOUR);
    expect(cpu.length).toBeLessThanOrEqual(90);
    expect(cpu[0]).toEqual({
      average: (10 + 20 * 11) / 12,
      high: 20,
      low: 10,
      t: NOW - 3 * DAY,
    });
  });

  test('bins the rollup cores of a process over the same width, and names it by its repository', async () => {
    await using h = await start();
    await addVitals(h.db.sql, 'server-1', -2 * 86_400, 10);
    await addProcess(h.db.sql, {
      cpuCores: 2,
      cwd: '/srv/trees/feature',
      end: -86_400 + 7200,
      pid: 10,
      readings: 'rollups',
      repository: '/srv/work/api',
      seenFrom: -86_400,
      seenTo: -86_400 + 7200,
      start: -86_400 - 3600,
      system: 'server-1',
    });
    await addSession(h.db.sql, {
      id: 's1',
      lastCwd: '/srv/trees/feature',
      requests: [-2 * 86_400, -86_400 + 600, -86_400 + 1200, 0],
      system: 'server-1',
    });

    const { bucketMs, processes } = await view(h);

    expect(processes.map(({ project }) => project)).toEqual(['api']);

    expect(bucketMs).toBe(HOUR);
    const points = processes[0]?.points ?? [];
    // The first hour's CPU time rose from the first reading to the last in it: 3585 seconds at 2 cores.
    expect(points[0]).toMatchObject({ t: NOW - DAY });
    expect(points[0]?.cores).toBeCloseTo((2 * 3585) / 3600, 5);
  });

  test('puts a subagent that worked past the main conversation inside the span', async () => {
    await using h = await start();
    await addSession(h.db.sql, {
      id: 's1',
      requests: [-600, -300],
      subagents: [{ agentId: 'a1', depth: 1, requests: [-900, -100] }],
      system: 'server-1',
    });

    const { endedAt, startedAt } = await view(h);

    expect([startedAt, endedAt]).toEqual([NOW - 900 * SECOND, NOW - 100 * SECOND]);
  });
});
