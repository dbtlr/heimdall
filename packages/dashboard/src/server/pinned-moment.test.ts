import { beforeAll, expect, test } from 'bun:test';

import { NOW, startHub, timeline } from '@heimdall/hub/testing';

import { readPinnedMoment } from './pinned-moment.ts';

beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

const HOUR_S = 3600;
const MINUTE_S = 60;
const { addSession, addVitals } = timeline(NOW);
const dollar = { inputTokens: 1_000_000, model: 'test-model', outputTokens: 0 };

const start = async () => {
  const h = await startHub();
  await h.db.sql`
    INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES ('test-model', '2020-01-01', 'bundled', 1, 2, 2000000)
  `;
  return h;
};

test('the pinned moment names the Sessions with a stretch running then and their cost, on Systems with no row', async () => {
  await using h = await start();
  // No `systems` row for either System: Sessions never need one.
  await addSession(h.db.sql, {
    ...dollar,
    id: 'running',
    lastCwd: '/srv/work/web-app',
    requests: [-3 * HOUR_S, -2 * HOUR_S - 50 * MINUTE_S, -2 * HOUR_S - 40 * MINUTE_S],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    ...dollar,
    harness: 'codex',
    id: 'also-running',
    lastCwd: '/srv/work/infra',
    requests: [-2 * HOUR_S - 55 * MINUTE_S, -2 * HOUR_S - 45 * MINUTE_S],
    system: 'laptop-1',
  });
  // Ended before the moment.
  await addSession(h.db.sql, { ...dollar, id: 'earlier', requests: [-5 * HOUR_S, -4 * HOUR_S] });
  // Started after it.
  await addSession(h.db.sql, { ...dollar, id: 'later', requests: [-HOUR_S, -HOUR_S + 60] });

  const moment = await readPinnedMoment(h.db.sql, {
    at: NOW - (2 * HOUR_S + 50 * MINUTE_S) * 1000,
    system: undefined,
  });

  expect(
    moment.sessions.map(({ costUsd, harness, project, sessionId, system }) => ({
      costUsd,
      harness,
      project,
      sessionId,
      system,
    })),
  ).toEqual([
    {
      costUsd: 3,
      harness: 'claude-code',
      project: 'web-app',
      sessionId: 'running',
      system: 'server-1',
    },
    {
      costUsd: 2,
      harness: 'codex',
      project: 'infra',
      sessionId: 'also-running',
      system: 'laptop-1',
    },
  ]);
});

test("the pinned moment reads a System's Vitals from the sample before it, else from the rollup holding it", async () => {
  await using h = await start();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1')`;
  await addVitals(h.db.sql, 'server-1', -2 * HOUR_S, 70);
  await addVitals(h.db.sql, 'server-1', -HOUR_S, 20);
  const at = NOW - 2 * HOUR_S * 1000 + 4 * MINUTE_S * 1000;

  const fromSample = await readPinnedMoment(h.db.sql, { at, system: 'server-1' });
  expect(fromSample.vitals).toMatchObject({
    cpu: 70,
    load: 1,
    memory: 50,
    t: NOW - 2 * HOUR_S * 1000,
  });

  // Once the raw samples are gone, the rollup holding the instant answers.
  await h.db.sql`DELETE FROM vitals_samples`;
  const fromRollup = await readPinnedMoment(h.db.sql, {
    at: NOW - 2 * HOUR_S * 1000,
    system: 'server-1',
  });
  expect(fromRollup.vitals).toMatchObject({ cpu: 70, memory: 50 });

  const none = await readPinnedMoment(h.db.sql, {
    at: NOW - 9 * HOUR_S * 1000,
    system: 'server-1',
  });
  expect(none.vitals).toBeUndefined();
});
