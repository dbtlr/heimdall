import { beforeAll, expect, test } from 'bun:test';

import { NOW, startHub, timeline } from '@heimdall/hub/testing';

import { readAgentsOverview } from './agents-overview.ts';

beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

const HOUR_S = 3600;
const { addSession } = timeline(NOW);
const dollar = { inputTokens: 1_000_000, model: 'test-model', outputTokens: 0 };

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

test('the chart prices requests per local day and key, only those in the period, and sums to the total', async () => {
  await using h = await start();
  // NOW is 12:00 UTC on 6 October; the 7d period starts at 12:00 on 29 September.
  await addSession(h.db.sql, {
    ...dollar,
    id: 'resumed',
    lastCwd: '/srv/work/api',
    // One before the period, which is not charted, then 5 October and today.
    requests: [-8 * 24 * HOUR_S, -20 * HOUR_S, -HOUR_S],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    ...dollar,
    harness: 'codex',
    id: 'other',
    lastCwd: '/srv/work/fleet',
    requests: [-30 * HOUR_S, { at: -2 * HOUR_S, model: 'unknown' }],
    system: 'laptop-1',
  });

  const { chart, totals } = await readAgentsOverview(h.db.sql, {
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });

  expect(chart.unit).toBe('day');
  expect(chart.buckets).toHaveLength(8);
  expect(chart.buckets.at(-1)?.start).toBe(Date.UTC(2026, 9, 6));
  const keyed = (bucket: number, harness: string, model: string, project: string) =>
    chart.cells.find(
      (cell) =>
        cell.bucket === bucket &&
        cell.harness === harness &&
        cell.model === model &&
        cell.project === project,
    );
  expect(keyed(6, 'claude-code', 'test-model', 'api')).toMatchObject({
    pricedCostUsd: 1,
    system: 'server-1',
  });
  expect(keyed(7, 'claude-code', 'test-model', 'api')).toMatchObject({ pricedCostUsd: 1 });
  expect(keyed(6, 'codex', 'test-model', 'fleet')).toMatchObject({
    pricedCostUsd: 1,
    system: 'laptop-1',
  });
  expect(keyed(7, 'codex', 'unknown', 'fleet')).toMatchObject({
    pricedCostUsd: 0,
    unpricedRequests: 1,
  });
  expect(chart.cells).toHaveLength(4);
  expect(chart.cells.reduce((sum, cell) => sum + cell.pricedCostUsd, 0)).toBe(totals.pricedCostUsd);
});

test('Today charts a bar per local hour, and reports today with what is usually spent by now', async () => {
  await using h = await start();
  // Three earlier days that each had spent $1 by 12:00, so $1 is usual by now.
  for (const [id, hours] of [
    ['a', 28],
    ['b', 52],
    ['c', 76],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of fixture Sessions.
    await addSession(h.db.sql, { ...dollar, id, requests: [-hours * HOUR_S], system: 'server-1' });
  }
  await addSession(h.db.sql, {
    ...dollar,
    id: 'now',
    requests: [-2.5 * HOUR_S, -1800],
    system: 'server-1',
  });

  const result = await readAgentsOverview(h.db.sql, { now: NOW, range: 'today', timeZone: 'UTC' });

  expect(result.chart.unit).toBe('hour');
  expect(result.chart.buckets).toHaveLength(13);
  expect(result.chart.cells.map(({ bucket }) => bucket).toSorted((a, b) => a - b)).toEqual([9, 11]);
  expect(result.today).toEqual(result.totals);
  expect(result.usualByNow).toBe(1);
});
