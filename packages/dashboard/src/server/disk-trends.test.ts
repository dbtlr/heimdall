import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub } from '@heimdall/hub/testing';

import { diskGrowth } from '../lib/disk-growth.ts';
import { readDiskTrends } from './disk-trends.ts';

const DAY = 86_400_000;
const GIB = 1024 ** 3;

beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

test('a replaced volume fits only since its last size change, including a return to its old size', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await h.db.sql`DELETE FROM disk_rollups`;
  await Promise.all(
    (
      [
        [7, 100, 60],
        [4, 1024, 600],
        [2, 100, 20],
        [1, 100, 22],
        [0, 100, 24],
      ] as const
    ).map(
      ([daysAgo, total, used]) => h.db.sql`
      INSERT INTO disk_rollups (system, mount, bucket, total_max, used_max)
      VALUES ('server-1', '/', ${new Date(NOW - daysAgo * DAY)}, ${total * GIB}, ${used * GIB})
    `,
    ),
  );
  const trends = await readDiskTrends(h.db.sql, { now: NOW, system: 'server-1' });
  expect(trends).toHaveLength(1);
  expect(trends[0]).toMatchObject({
    count: 3,
    firstAt: NOW - 2 * DAY,
    lastAt: NOW,
    latestUsedBytes: 24 * GIB,
    totalBytes: 100 * GIB,
  });
  expect(trends[0]?.growth?.bytesPerDay).toBeCloseTo(2 * GIB, -3);
  await h.db.sql`
    INSERT INTO disk_rollups (system, mount, bucket, total_max, used_max)
    VALUES ('server-1', '/', ${new Date(NOW + 300_000)}, ${1024 * GIB}, ${600 * GIB})
  `;
  const replaced = await readDiskTrends(h.db.sql, { now: NOW + 300_000, system: 'server-1' });
  expect(replaced[0]?.growth).toBeUndefined();
  expect(replaced[0]?.count).toBe(1);
  await h.db.sql`
    INSERT INTO disk_rollups (system, mount, bucket, total_max, used_max)
    VALUES ('server-1', '/', ${new Date(NOW + 3_600_000)}, ${1024 * GIB}, ${601 * GIB})
  `;
  const short = await readDiskTrends(h.db.sql, { now: NOW + 3_600_000, system: 'server-1' });
  expect(short[0]?.count).toBe(2);
  expect(short[0]?.growth).toBeUndefined();
});

test('SQL summaries match the existing fit for steady, noisy, flat, shrinking and full mounts', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await h.db.sql`DELETE FROM disk_rollups`;
  const fixtures = (
    [
      ['/steady', 2, 100, 0],
      ['/noisy', 1, 100, 0.3],
      ['/flat', 0, 100, 0],
      ['/shrinking', -1, 100, 0],
      ['/full', 1, 200, 0],
    ] as const
  ).map(([mount, rate, initial, noise]) => {
    const readings = Array.from({ length: 2017 }, (_, index) => ({
      t: NOW - 7 * DAY + index * 300_000,
      totalBytes: 200 * GIB,
      usedBytes: Math.round(
        (initial + (rate * index) / 288 + (index % 2 === 0 ? noise : -noise)) * GIB,
      ),
    }));
    return { mount, readings };
  });
  await Promise.all(
    fixtures.map(
      ({ mount, readings }) => h.db.sql`
      INSERT INTO disk_rollups ${h.db.sql(
        readings.map((r) => ({
          bucket: new Date(r.t),
          mount,
          system: 'server-1',
          total_max: r.totalBytes,
          used_max: r.usedBytes,
        })),
      )}
    `,
    ),
  );
  const trends = await readDiskTrends(h.db.sql, { now: NOW, system: 'server-1' });
  expect(trends).toHaveLength(5);
  for (const { mount, readings } of fixtures) {
    const trend = trends.find((row) => row.mount === mount);
    expect(trend?.count).toBe(2017);
    const expected = diskGrowth(readings);
    if (expected === undefined) {
      throw new Error('Seven days of readings must yield a fit.');
    }
    expect(trend?.growth?.bytesPerDay).toBeCloseTo(expected.bytesPerDay, -3);
  }
});
