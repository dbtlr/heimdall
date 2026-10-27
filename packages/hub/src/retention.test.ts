import { expect, test } from 'bun:test';

import { sample } from '@heimdall/schema/testing';
import type { SQL } from 'bun';

import { pruneServiceStops, pruneVitals } from './retention.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';

const DAY = 86_400_000;

const store = async (h: Awaited<ReturnType<typeof startHub>>, times: number[]) => {
  const response = await push(h.hub, report('laptop-1', times), { token: 'laptop-token' });
  expect(response.status).toBe(200);
};

const sampleTimes = async (sql: SQL) => {
  const rows: { t: Date }[] = await sql`SELECT t FROM vitals_samples ORDER BY t`;
  return rows.map((row) => row.t.getTime());
};

const vitalsBuckets = async (sql: SQL) => {
  const rows: { bucket: Date }[] = await sql`SELECT bucket FROM vitals_rollups ORDER BY bucket`;
  return rows.map((row) => row.bucket.getTime());
};

const diskBuckets = async (sql: SQL) => {
  const rows: { bucket: Date }[] =
    await sql`SELECT DISTINCT bucket FROM disk_rollups ORDER BY bucket`;
  return rows.map((row) => row.bucket.getTime());
};

test('pruning deletes raw samples older than 14 days and keeps the rest', async () => {
  await using h = await startHub();
  const cutoff = NOW - 14 * DAY;
  await store(h, [cutoff - DAY, cutoff - 1, cutoff, cutoff + 1, NOW]);

  const pruned = await pruneVitals(h.db.sql, NOW);

  expect(pruned.samples).toBe(2);
  expect(await sampleTimes(h.db.sql)).toEqual([cutoff, cutoff + 1, NOW]);
});

test('pruning leaves the rollups of samples it deletes within the year', async () => {
  await using h = await startHub();
  await store(h, [NOW - 20 * DAY, NOW]);

  await pruneVitals(h.db.sql, NOW);

  expect(await sampleTimes(h.db.sql)).toEqual([NOW]);
  expect(await vitalsBuckets(h.db.sql)).toEqual([NOW - 20 * DAY, NOW]);
  expect(await diskBuckets(h.db.sql)).toEqual([NOW - 20 * DAY, NOW]);
});

test('pruning deletes Vitals and disk rollups older than a year and keeps the rest', async () => {
  await using h = await startHub();
  const cutoff = NOW - 365 * DAY;
  // The cutoff is on a bucket boundary, so a sample just before it is in the
  // bucket before, and a sample at it starts the bucket the prune keeps.
  await store(h, [cutoff - 2 * DAY, cutoff - 1, cutoff, cutoff + DAY, NOW]);

  const pruned = await pruneVitals(h.db.sql, NOW);

  expect(pruned.vitalsRollups).toBe(2);
  expect(pruned.diskRollups).toBe(2 * sample(NOW).disks.length);
  expect(await vitalsBuckets(h.db.sql)).toEqual([cutoff, cutoff + DAY, NOW]);
  expect(await diskBuckets(h.db.sql)).toEqual([cutoff, cutoff + DAY, NOW]);
});

test('pruning an empty database deletes nothing', async () => {
  await using h = await startHub();

  expect(await pruneVitals(h.db.sql, NOW)).toEqual({
    diskRollups: 0,
    processRollups: 0,
    processSamples: 0,
    samples: 0,
    vitalsRollups: 0,
  });
});

test('pruning Service stops deletes only ended stops strictly older than 90 days', async () => {
  await using h = await startHub();
  const cutoff = NOW - 90 * DAY;
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1') ON CONFLICT DO NOTHING`;
  for (const [time, ongoing] of [
    [cutoff - 1, false],
    [cutoff - DAY, true],
    [cutoff, false],
    [NOW, false],
  ] satisfies [number, boolean][]) {
    // oxlint-disable-next-line no-await-in-loop -- four retention boundaries.
    await h.db.sql`
      INSERT INTO service_stops (system, service, stopped_at, ongoing, restarts, sent_at, received_at)
      VALUES ('laptop-1', 'web', ${new Date(time)}, ${ongoing}, 0, ${new Date(NOW)}, ${new Date(NOW)})
    `;
  }

  expect(await pruneServiceStops(h.db.sql, NOW)).toBe(1);
  const kept: { stopped_at: Date }[] = await h.db
    .sql`SELECT stopped_at FROM service_stops ORDER BY stopped_at`;
  expect(kept.map((row) => row.stopped_at.getTime())).toEqual([cutoff - DAY, cutoff, NOW]);
});
