import { beforeAll, expect, test } from 'bun:test';

import { NOW, startHub, timeline } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import type { SessionsQuery } from './agents-overview-types.ts';
import { readAgentsOverview } from './agents-overview.ts';

beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

const { addSession } = timeline(NOW);
const DAY_S = 86_400;

const start = async () => {
  const h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1'), ('laptop-1')`;
  await h.db.sql`
    INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES ('test-model', '2020-01-01', 'bundled', 1, 2, 2000000),
           ('other-model', '2020-01-01', 'bundled', 1, 2, 2000000)
  `;
  return h;
};

const table = async (h: Hub, query: Partial<SessionsQuery> = {}) =>
  (await readAgentsOverview(h.db.sql, { now: NOW, range: '30d', table: query, timeZone: 'UTC' }))
    .table;

const ids = (page: Awaited<ReturnType<typeof table>>) =>
  page.sessions.map((session) => session.sessionId);

test('the table is newest first by default, and a sort reorders the whole range before it is paged', async () => {
  await using h = await start();
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    // oxlint-disable-next-line no-await-in-loop -- seeded in order.
    await addSession(h.db.sql, {
      id,
      inputTokens: (3 - index) * 1_000_000,
      model: 'test-model',
      outputTokens: 0,
      requests: [-(10 - index) * DAY_S, -(10 - index) * DAY_S + 60],
      system: 'server-1',
    });
  }

  expect(ids(await table(h))).toEqual(['c', 'b', 'a']);
  expect(ids(await table(h, { dir: 'asc', sort: 'started' }))).toEqual(['a', 'b', 'c']);
  // Costs: a $6, b $4, c $2 (two requests each at $1 per million input tokens).
  expect(ids(await table(h, { dir: 'desc', sort: 'cost' }))).toEqual(['a', 'b', 'c']);
  const second = await table(h, { dir: 'desc', page: 2, sort: 'cost' });
  expect(second.page).toBe(1);
  expect(second.total).toBe(3);
});

test('Sessions running now stay above the sorted rows, and total counts every match across pages', async () => {
  await using h = await start();
  for (let index = 0; index < 27; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- seeded in order.
    await addSession(h.db.sql, {
      id: `s${String(index).padStart(2, '0')}`,
      model: 'test-model',
      requests: [-(index + 1) * 3600 - 600],
      system: 'server-1',
    });
  }
  await addSession(h.db.sql, {
    id: 'running-old-start',
    model: 'test-model',
    requests: [-20 * DAY_S, -30],
    system: 'laptop-1',
  });

  const first = await table(h, { dir: 'asc', sort: 'started' });
  expect(first.total).toBe(28);
  expect(first.sessions).toHaveLength(25);
  // The running Session has the most requests, so fewest-first sorts it last until it is pinned.
  const byRequests = await table(h, { dir: 'asc', sort: 'requests' });
  expect(byRequests.sessions[0]?.sessionId).toBe('running-old-start');
  const last = await table(h, { dir: 'desc', page: 2, sort: 'started' });
  expect(last.page).toBe(2);
  expect(last.sessions).toHaveLength(3);
  expect(last.sessions.some((session) => session.sessionId === 'running-old-start')).toBe(false);
});

test('a Session crossing the period start is priced for its requests inside it, and a pick filters in the database', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    id: 'crossing',
    inputTokens: 1_000_000,
    lastCwd: '/srv/work/api',
    model: 'test-model',
    outputTokens: 0,
    requests: [-31 * DAY_S, -2 * DAY_S, -DAY_S],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    id: 'inside',
    inputTokens: 1_000_000,
    lastCwd: '/srv/work/web',
    model: 'other-model',
    outputTokens: 0,
    requests: [-3600],
    system: 'laptop-1',
  });

  await addSession(h.db.sql, {
    firstCwd: '/',
    id: 'rootless',
    model: '',
    requests: [-7200],
    system: 'laptop-1',
  });

  const all = await table(h, { sort: 'cost' });
  expect(all.sessions.find((session) => session.sessionId === 'crossing')).toMatchObject({
    pricedCostUsd: 2,
    requests: 2,
  });
  expect(await table(h, { by: 'project', pick: 'api' })).toMatchObject({ total: 1 });
  expect(ids(await table(h, { by: 'model', pick: 'other-model' }))).toEqual(['inside']);
  expect(ids(await table(h, { by: 'system', pick: 'server-1' }))).toEqual(['crossing']);
  // The empty key picks Sessions with no project, or requests with no model.
  expect(ids(await table(h, { by: 'project', pick: '' }))).toEqual(['rootless']);
  expect(ids(await table(h, { by: 'model', pick: '' }))).toEqual(['rootless']);
  expect((await table(h, { by: 'harness', pick: 'nobody' })).total).toBe(0);
});
