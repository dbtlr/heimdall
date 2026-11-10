import { beforeAll, expect, test } from 'bun:test';

import { NOW, startHub, timeline } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { readAgentsOverview } from './agents-overview.ts';
import { readHome } from './home.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

const HOUR_S = 3600;

const { addSession } = timeline(NOW);

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

const dollar = { inputTokens: 1_000_000, model: 'test-model', outputTokens: 0 };

const agentsOf = async (h: Hub, timeZone: string) => {
  const { agents } = await readHome(h.db.sql, { now: NOW, timeZone, unpaired: false });
  if (agents === undefined) {
    throw new Error('Home read no agent work');
  }
  return agents;
};

test("today's cost is the Agents page's Today total in the same zone, unpriced requests counted", async () => {
  await using h = await start();
  // Berlin's 6 October starts at 22:00 UTC the day before, 50,400 s before NOW.
  await addSession(h.db.sql, {
    ...dollar,
    id: 'overnight',
    requests: [-50_401, -50_400, -3 * HOUR_S],
    subagentRequests: [-2 * HOUR_S],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    ...dollar,
    id: 'unpriced',
    requests: [-HOUR_S, { at: -HOUR_S + 60, model: 'unknown' }],
    system: 'laptop-1',
  });

  const agents = await agentsOf(h, 'Europe/Berlin');
  const overview = await readAgentsOverview(h.db.sql, {
    now: NOW,
    range: 'today',
    timeZone: 'Europe/Berlin',
  });

  expect(agents.today).toEqual(overview.totals);
  expect(agents.today).toEqual({ pricedCostUsd: 4, requests: 5, unpricedRequests: 1 });
  expect(agents.days.at(-1)).toMatchObject({ pricedCostUsd: 4, unpricedRequests: 1 });
});

test('running Sessions have a request in the last 5 minutes, the latest first, each priced over all its requests', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    ...dollar,
    id: 'edge',
    requests: [-HOUR_S, -300],
    system: 'server-1',
  });
  await addSession(h.db.sql, { ...dollar, id: 'ended', requests: [-301], system: 'server-1' });
  await addSession(h.db.sql, {
    ...dollar,
    id: 'long',
    requests: [-30 * HOUR_S, { at: -50, model: 'other' }, { at: -10, model: 'other' }],
    system: 'server-1',
  });
  // A System purged after its Sessions were archived has no systems row.
  await addSession(h.db.sql, {
    ...dollar,
    harness: 'codex',
    id: 'kept',
    requests: [-5],
    system: 'gone-1',
  });

  const agents = await agentsOf(h, 'UTC');

  expect(agents.running.map(({ sessionId, system }) => [system, sessionId])).toEqual([
    ['gone-1', 'kept'],
    ['server-1', 'long'],
    ['server-1', 'edge'],
  ]);
  expect(agents.running[1]).toMatchObject({
    firstRequestAt: NOW - 30 * HOUR_S * 1000,
    pricedCostUsd: 1,
    topModel: 'other',
    unpricedRequests: 2,
  });
  expect(agents.latestRequestAt).toBeUndefined();
});

test('the bars hold the 6 days before today and today, and usually by now is the median of the 7 days before', async () => {
  await using h = await start();
  // NOW is 12:00 UTC. Each day's requests, as hours before NOW: 5 October
  // spent $1 by 12:00 of $2, 4 October $1 of $1, 3 October $0 of $1, and 29
  // September, a day too old for the bars, $3 of $3.
  const days: [string, number[]][] = [
    ['oct-5', [26, 22]],
    ['oct-4', [51]],
    ['oct-3', [71]],
    ['sep-29', [172, 169, 168.5]],
    ['today', [1]],
  ];
  for (const [id, hours] of days) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of fixture Sessions.
    await addSession(h.db.sql, {
      ...dollar,
      id,
      requests: hours.map((hour) => -hour * HOUR_S),
      system: 'server-1',
    });
  }

  const agents = await agentsOf(h, 'UTC');

  expect(
    agents.days.map(({ pricedCostUsd, start: dayStart }) => [dayStart, pricedCostUsd]),
  ).toEqual([
    [Date.UTC(2026, 8, 30), 0],
    [Date.UTC(2026, 9, 1), 0],
    [Date.UTC(2026, 9, 2), 0],
    [Date.UTC(2026, 9, 3), 1],
    [Date.UTC(2026, 9, 4), 1],
    [Date.UTC(2026, 9, 5), 2],
    [Date.UTC(2026, 9, 6), 1],
  ]);
  expect(agents.usualByNow).toBe(1);
  expect(agents.running).toEqual([]);
  expect(agents.latestRequestAt).toBe(NOW - HOUR_S * 1000);
});

test('with no Session ever recorded, Home reads no cost, nothing running, and no latest request', async () => {
  await using h = await start();

  const agents = await agentsOf(h, 'UTC');

  expect(agents.today).toEqual({ pricedCostUsd: 0, requests: 0, unpricedRequests: 0 });
  expect(agents.days.every(({ requests }) => requests === 0)).toBe(true);
  expect(agents.running).toEqual([]);
  expect(agents.usualByNow).toBeUndefined();
  expect(agents.latestRequestAt).toBeUndefined();
});

test('Home reads no agent work until the time zone is known', async () => {
  await using h = await start();

  expect((await readHome(h.db.sql, { now: NOW, unpaired: false })).agents).toBeUndefined();
});
