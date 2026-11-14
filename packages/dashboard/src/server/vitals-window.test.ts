import { beforeAll, expect, test } from 'bun:test';

import {
  NOW,
  startHub,
  storeConditionLimits,
  parseConditionLimits,
  timeline,
} from '@heimdall/hub/testing';

import { readVitalsWindow } from './vitals-window.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BUCKET_MS = 5 * MINUTE * 1000;

const { addVitals, at } = timeline(NOW);

const bucketOf = (seconds: number) => Math.floor(at(seconds).getTime() / BUCKET_MS) * BUCKET_MS;

const read = (sql: Parameters<typeof readVitalsWindow>[0], from: number, to: number) =>
  readVitalsWindow(sql, {
    from: at(from).getTime(),
    now: NOW,
    system: 'server-1',
    to: at(to).getTime(),
  });

test('a short recent window reads the raw samples, as percent and load', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1')`;
  await addVitals(h.db.sql, 'server-1', -20 * MINUTE, 40);
  await addVitals(h.db.sql, 'server-1', -10 * MINUTE + 30, 60);
  await addVitals(h.db.sql, 'server-1', -3 * HOUR, 99);

  const found = await read(h.db.sql, -HOUR, -5 * MINUTE);

  expect(found.source).toBe('samples');
  expect(found.points).toEqual([
    { cpu: 40, load: 1, memory: 50, t: at(-20 * MINUTE).getTime() },
    { cpu: 60, load: 1, memory: 50, t: at(-10 * MINUTE + 30).getTime() },
  ]);
});

test('a window from before the raw samples are kept reads the 5-minute averages', async () => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1')`;
  await addVitals(h.db.sql, 'server-1', -20 * DAY, 40);
  await addVitals(h.db.sql, 'server-1', -20 * DAY + 10 * MINUTE, 60);
  await addVitals(h.db.sql, 'server-1', -20 * DAY + HOUR, 10);

  const found = await read(h.db.sql, -20 * DAY - 30 * MINUTE, -20 * DAY + 30 * MINUTE);

  expect(found.source).toBe('rollups');
  expect(found.points).toEqual([
    { cpu: 40, load: 1, memory: 50, t: bucketOf(-20 * DAY) },
    { cpu: 60, load: 1, memory: 50, t: bucketOf(-20 * DAY + 10 * MINUTE) },
  ]);
});

test('the window ends at now, and carries the limits the Hub judges by', async () => {
  await using h = await startHub();
  await storeConditionLimits(h.db.sql, parseConditionLimits({ cpu: { percent: 77 }, systems: {} }));

  const found = await read(h.db.sql, -HOUR, HOUR);

  expect(found.to).toBe(NOW);
  expect(found.points).toEqual([]);
  expect(found.limits.cpuPercent).toBe(77);
});
