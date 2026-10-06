import { expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';

import { sample } from '@heimdall/schema/testing';
import type { SQL } from 'bun';

import { every, pruneVitals, RAW_RETENTION_MS, ROLLUP_RETENTION_MS } from './retention.ts';
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

test('retention keeps raw samples for 14 days and rollups for a year', () => {
  expect([RAW_RETENTION_MS, ROLLUP_RETENTION_MS]).toEqual([14 * DAY, 365 * DAY]);
});

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
    samples: 0,
    vitalsRollups: 0,
  });
});

test('every runs the task at once, then again after each interval', async () => {
  let runs = 0;
  const stop = every({ intervalMs: 20, onError: () => {}, task: () => void (runs += 1) });

  expect(runs).toBe(1);
  await wait(110);
  await stop();

  expect(runs).toBeGreaterThanOrEqual(3);
});

test('every stops running the task once stopped', async () => {
  let runs = 0;
  const stop = every({ intervalMs: 10, onError: () => {}, task: () => void (runs += 1) });
  await wait(35);
  await stop();
  const stoppedAt = runs;

  await wait(50);

  expect(runs).toBe(stoppedAt);
});

test('every keeps running after a task fails and reports each failure', async () => {
  const failures: unknown[] = [];
  let runs = 0;
  const stop = every({
    intervalMs: 10,
    onError: (error) => failures.push(error),
    task: () => {
      runs += 1;
      if (runs === 1) {
        throw new Error('first run fails');
      }
      return Promise.reject(new Error('later run fails'));
    },
  });
  await wait(60);
  await stop();

  expect(runs).toBeGreaterThan(2);
  expect(failures).toHaveLength(runs);
  expect((failures[0] as Error).message).toBe('first run fails');
});

test('stopping waits for a task still running', async () => {
  let finished = false;
  const stop = every({
    intervalMs: 1000,
    onError: () => {},
    task: async () => {
      await wait(30);
      finished = true;
    },
  });

  await stop();

  expect(finished).toBe(true);
});
