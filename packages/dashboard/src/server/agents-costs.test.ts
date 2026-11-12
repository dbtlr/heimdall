import { beforeAll, expect, test } from 'bun:test';

import { NOW, refreshSessionInsight, startHub, timeline } from '@heimdall/hub/testing';
import type { SQL } from 'bun';

import { readCostChart } from './agents-costs.ts';
import { readAgentsOverview, todayPeriod } from './agents-overview.ts';

beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

const HOUR_S = 3600;
const DAY_MS = 86_400_000;
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
  // Three earlier days that had spent $1, $1, and $3 by 12:00, so $1 is usual
  // by now; with today's $2 among them it would be $1.50.
  for (const [id, hours] of [
    ['a', [28]],
    ['b', [52]],
    ['c', [76, 75.9, 75.8]],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of fixture Sessions.
    await addSession(h.db.sql, {
      ...dollar,
      id,
      requests: hours.map((ago) => -ago * HOUR_S),
      system: 'server-1',
    });
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

test('the longer ranges report Today from local midnight, not their own total', async () => {
  await using h = await start();
  await addSession(h.db.sql, {
    ...dollar,
    id: 'yesterday',
    requests: [-20 * HOUR_S],
    system: 'server-1',
  });
  await addSession(h.db.sql, { ...dollar, id: 'today', requests: [-HOUR_S], system: 'server-1' });

  const { today, totals } = await readAgentsOverview(h.db.sql, {
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });

  expect(totals.pricedCostUsd).toBe(2);
  expect(today).toEqual({ pricedCostUsd: 1, requests: 1, unpricedRequests: 0 });
});

test('the chart counts only requests inside the period, as the total does', async () => {
  await using h = await start();
  // The 7d period starts at 12:00 on 29 September, the first bar's day: the
  // request at 11:00 that day is before it. The request 10 minutes after now,
  // from a clock running ahead, is after it.
  await addSession(h.db.sql, {
    ...dollar,
    id: 'started-before',
    requests: [-(7 * 24 + 1) * HOUR_S, -(7 * 24 - 1) * HOUR_S],
    system: 'server-1',
  });
  await addSession(h.db.sql, {
    ...dollar,
    id: 'clock-ahead',
    requests: [-HOUR_S, 600],
    system: 'server-1',
  });

  const { chart, totals } = await readAgentsOverview(h.db.sql, {
    now: NOW,
    range: '7d',
    timeZone: 'UTC',
  });

  expect(totals.pricedCostUsd).toBe(2);
  const costOf = (bucket: number) =>
    chart.cells
      .filter((cell) => cell.bucket === bucket)
      .reduce((sum, cell) => sum + cell.pricedCostUsd, 0);
  expect(costOf(0)).toBe(1);
  expect(costOf(7)).toBe(1);
});

test('cells merge working directories that name one project, and keep Systems apart', async () => {
  await using h = await start();
  for (const [id, system, lastCwd] of [
    ['one', 'server-1', '/srv/one/api'],
    ['two', 'server-1', '/srv/two/api'],
    ['three', 'laptop-1', '/home/someone/api'],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of fixture Sessions.
    await addSession(h.db.sql, { ...dollar, id, lastCwd, requests: [-HOUR_S], system });
  }

  const { chart } = await readAgentsOverview(h.db.sql, {
    now: NOW,
    range: 'today',
    timeZone: 'UTC',
  });

  expect(
    chart.cells
      .map(({ pricedCostUsd, project, system }) => ({ pricedCostUsd, project, system }))
      .toSorted((a, b) => a.system.localeCompare(b.system)),
  ).toEqual([
    { pricedCostUsd: 1, project: 'api', system: 'laptop-1' },
    { pricedCostUsd: 2, project: 'api', system: 'server-1' },
  ]);
});

// The request entries `read` examines, through any index or a sequential scan
// of the requests, with sequential scans discouraged as their cost does on a
// live archive. The counts are the backend's own, read before and after in
// one transaction, since they can still hold what earlier statements on the
// connection examined.
const requestsExamined = (sql: SQL, read: (tx: SQL) => Promise<unknown>) =>
  sql.begin(async (tx) => {
    const examined = async () => {
      const [row]: { examined: number }[] = await tx`
        SELECT (sum(pg_stat_get_xact_tuples_returned(c.oid)))::int AS examined
        FROM pg_class c
        WHERE c.oid = 'projected_requests'::regclass
           OR c.oid IN (SELECT indexrelid FROM pg_index
                        WHERE indrelid = 'projected_requests'::regclass)
      `;
      return row?.examined ?? 0;
    };
    await tx`SET LOCAL enable_seqscan = off`;
    const before = await examined();
    await read(tx);
    return (await examined()) - before;
  });

// How many requests a year-old Session made before it was resumed today.
const HISTORY = 500;

test.each(['today', '30d'] as const)(
  "the %s chart examines the requests in its bars, not a resumed Session's history",
  async (range) => {
    await using h = await start();
    await addSession(h.db.sql, {
      ...dollar,
      id: 'resumed',
      requests: [-365 * 24 * HOUR_S, -HOUR_S],
      system: 'server-1',
    });
    await h.db.sql`
      INSERT INTO projected_requests (harness, parser_version, system, source, session_id,
                                      request_id, at, model, input_tokens, output_tokens,
                                      cache_read_tokens, cache_write_tokens, generation, byte_offset)
      SELECT harness, parser_version, system, source, session_id, 'history-' || n,
             at + n * interval '1 minute', model, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, generation, 10000 + n
      FROM projected_requests, generate_series(1, ${HISTORY}) n
      WHERE request_id = 'resumed-0'
    `;
    await refreshSessionInsight(h.db.sql, { budgetMs: Number.POSITIVE_INFINITY });
    await h.db.sql`ANALYZE projected_requests`;
    const period =
      range === 'today'
        ? todayPeriod(NOW, 'UTC')
        : { from: new Date(NOW - 30 * DAY_MS), to: new Date(NOW) };

    expect(
      await requestsExamined(h.db.sql, (tx) =>
        readCostChart(tx, { now: NOW, period, range, timeZone: 'UTC' }),
      ),
    ).toBeLessThan(HISTORY / 10);
  },
);
