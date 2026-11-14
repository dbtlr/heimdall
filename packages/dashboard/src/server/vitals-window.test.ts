import { beforeAll, expect, test } from 'bun:test';

import { NOW, startHub, parseConditionLimits, timeline } from '@heimdall/hub/testing';

import { readVitalsWindow } from './vitals-window.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MINUTE_MS = MINUTE * 1000;

const { addVitals, at } = timeline(NOW);

const LIMITS = parseConditionLimits({ cpu: { percent: 77 }, memory: { percent: 88 }, systems: {} });

const read = (
  sql: Parameters<typeof readVitalsWindow>[0],
  from: number,
  to: number,
  platform: string | undefined = 'linux',
) =>
  readVitalsWindow(sql, {
    from: at(from).getTime(),
    limits: LIMITS,
    now: NOW,
    platform,
    system: 'server-1',
    to: at(to).getTime(),
  });

test('a short recent window averages the raw samples a minute at a time, as percent and load', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1')`;
  await addVitals(h.db.sql, 'server-1', -20 * MINUTE, 40);
  await addVitals(h.db.sql, 'server-1', -20 * MINUTE + 30, 60);
  await addVitals(h.db.sql, 'server-1', -10 * MINUTE + 30, 60);
  await addVitals(h.db.sql, 'server-1', -3 * HOUR, 99);

  const found = await read(h.db.sql, -HOUR, -5 * MINUTE);

  expect(found).toMatchObject({ bucketMs: MINUTE_MS, source: 'samples' });
  expect(found.points).toEqual([
    { cpu: 50, load: 1, memory: 50, t: at(-20 * MINUTE + 30).getTime() },
    { cpu: 60, load: 1, memory: 50, t: at(-10 * MINUTE + 30).getTime() },
  ]);
});

test('a window from before the raw samples are kept averages the rollups, from the one holding its start', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1')`;
  // In the rollup that starts 3 minutes before the window does.
  await addVitals(h.db.sql, 'server-1', -20 * DAY - 33 * MINUTE, 40);
  await addVitals(h.db.sql, 'server-1', -20 * DAY + 10 * MINUTE, 60);
  await addVitals(h.db.sql, 'server-1', -20 * DAY + HOUR, 10);

  const found = await read(h.db.sql, -20 * DAY - 32 * MINUTE, -20 * DAY + 30 * MINUTE);

  expect(found).toMatchObject({ bucketMs: 5 * MINUTE_MS, source: 'rollups' });
  expect(found.points.map(({ cpu }) => cpu)).toEqual([40, 60]);
  // The first rollup's middle comes before the window's start, so it sits at the start.
  expect(found.points[0]?.t).toBe(at(-20 * DAY - 32 * MINUTE).getTime());
});

test('a window of months reads a bounded number of averages, whatever it holds', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1')`;
  await addVitals(h.db.sql, 'server-1', -200 * DAY, 20);
  await addVitals(h.db.sql, 'server-1', -200 * DAY + HOUR, 40);
  await addVitals(h.db.sql, 'server-1', -100 * DAY, 90);

  const found = await read(h.db.sql, -300 * DAY, 0);

  expect(found).toMatchObject({ bucketMs: 2 * DAY * 1000, source: 'rollups' });
  expect(found.points.map(({ cpu }) => cpu)).toEqual([30, 90]);
});

test('the window ends at now, and carries the limits the Hub judges by', async () => {
  await using h = await startHub();

  const found = await read(h.db.sql, -HOUR, HOUR);

  expect(found.to).toBe(NOW);
  expect(found.points).toEqual([]);
  expect(found.limits).toEqual({ cpuPercent: 77, memoryPercent: 88 });
});

test('a macOS System draws no memory limit, since the Hub judges its memory by kernel pressure', async () => {
  await using h = await startHub();

  const found = await read(h.db.sql, -HOUR, 0, 'darwin');

  expect(found.limits).toEqual({ cpuPercent: 77, memoryPercent: undefined });
});
