import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline, unpair } from '@heimdall/hub/testing';

import { readActivityPage } from './activity-axis.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const { addSession, addVitals } = timeline(NOW);

test('each System gets a lane of CPU in axis buckets and its Session stretches, paired Systems first, with no systems row needed', async () => {
  await using h = await startHub();
  const { sql } = h.db;
  await push(h.hub, report('server-1', [NOW - 25 * HOUR]), { token: 'server-token' });
  // An unpaired System whose history is kept, with a Session in the range.
  await push(h.hub, report('laptop-1', [NOW - 25 * HOUR]), { token: 'laptop-token' });
  await unpair(sql, 'laptop-1');
  await addSession(sql, { id: 'kept', requests: [-2 * 3600], system: 'laptop-1' });
  // Samples 2 minutes apart averaged in one 10-minute bucket, then one in the next.
  for (const minutes of [-120, -118, -116, -114, -110]) {
    // oxlint-disable-next-line no-await-in-loop -- fixture rows.
    await addVitals(sql, 'server-1', minutes * 60, minutes === -110 ? 90 : 10 + minutes + 120);
  }
  // A Session on a System the Hub never heard a Report from or paired.
  await addSession(sql, { id: 'solo', requests: [-3 * 3600, -3 * 3600 + 120], system: 'build-1' });
  await addSession(sql, {
    id: 'old',
    requests: [-3 * 86_400, -3 * 86_400 + 60],
    system: 'build-1',
  });

  const page = await readActivityPage(sql, { now: NOW, range: '24h' });

  expect(page.bucketMs).toBe(10 * MINUTE);
  expect(page.lanes.map(({ system, unpaired }) => ({ system, unpaired }))).toEqual([
    { system: 'server-1', unpaired: false },
    { system: 'build-1', unpaired: true },
    { system: 'laptop-1', unpaired: true },
  ]);
  expect(page.unpaired).toEqual(['build-1', 'laptop-1']);
  expect(page.systems).toEqual(['build-1', 'laptop-1', 'server-1']);
  const [server, build] = page.lanes;
  expect(build?.stretches).toEqual([
    { endedAt: NOW - 3 * HOUR + 2 * MINUTE, harness: 'claude-code', startedAt: NOW - 3 * HOUR },
  ]);
  expect(build?.buckets).toEqual([]);
  expect(server?.buckets.map(({ average, high, low }) => ({ average, high, low }))).toEqual([
    { average: 13, high: 16, low: 10 },
    { average: 90, high: 90, low: 90 },
  ]);
});

test('a lane joins the stretches of one Harness closer than the axis tells apart, and keeps the rest apart', async () => {
  await using h = await startHub();
  const { sql } = h.db;
  await push(h.hub, report('server-1', [NOW - HOUR]), { token: 'server-token' });
  // Over 24 hours the axis tells apart stretches 2 minutes apart: these two
  // Sessions' stretches lie 1 minute apart, with a Codex one between them.
  await addSession(sql, { id: 'a', requests: [-4 * 3600, -4 * 3600 + 60], system: 'server-1' });
  await addSession(sql, {
    id: 'b',
    requests: [-4 * 3600 + 120, -4 * 3600 + 180],
    system: 'server-1',
  });
  await addSession(sql, {
    harness: 'codex',
    id: 'c',
    requests: [-4 * 3600 + 90, -4 * 3600 + 100],
    system: 'server-1',
  });
  // An hour earlier, far enough apart to draw on its own.
  await addSession(sql, { id: 'd', requests: [-5 * 3600, -5 * 3600 + 60], system: 'server-1' });

  const page = await readActivityPage(sql, { now: NOW, range: '24h' });

  expect(page.lanes.find(({ system }) => system === 'server-1')?.stretches).toEqual([
    { endedAt: NOW - 5 * HOUR + MINUTE, harness: 'claude-code', startedAt: NOW - 5 * HOUR },
    { endedAt: NOW - 4 * HOUR + 3 * MINUTE, harness: 'claude-code', startedAt: NOW - 4 * HOUR },
    { endedAt: NOW - 4 * HOUR + 100_000, harness: 'codex', startedAt: NOW - 4 * HOUR + 90_000 },
  ]);
});
