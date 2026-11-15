import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline } from '@heimdall/hub/testing';

import { conditionDetailView } from '../lib/condition-detail.ts';
import { readConditionDetail } from './condition-detail.ts';
import { readDiskTrends } from './disk-trends.ts';
import { readSystemPage } from './system-detail.ts';

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
    count: 2,
    firstAt: NOW - DAY,
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
  expect(replaced[0]?.count).toBe(0);
  await h.db.sql`
    INSERT INTO disk_rollups (system, mount, bucket, total_max, used_max)
    VALUES ('server-1', '/', ${new Date(NOW + 3_600_000)}, ${1024 * GIB}, ${601 * GIB})
  `;
  const short = await readDiskTrends(h.db.sql, { now: NOW + 3_600_000, system: 'server-1' });
  expect(short[0]?.count).toBe(1);
  expect(short[0]?.growth).toBeUndefined();
});

test('SQL summaries fit known rates for steady, noisy, flat, shrinking and full mounts', async () => {
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
    return { mount, rate, readings };
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
  for (const { mount, rate } of fixtures) {
    const trend = trends.find((row) => row.mount === mount);
    expect(trend?.count).toBe(2017);
    expect(trend?.growth?.bytesPerDay).toBeCloseTo(rate * GIB, -3);
  }
});

for (const [name, stepHours] of [
  ['every bucket', 1 / 12],
  ['every 20 hours', 20],
] as const) {
  test(`small size jitter ${name} preserves a two GiB daily fit`, async () => {
    await using h = await startHub();
    await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
    await h.db.sql`DELETE FROM disk_rollups`;
    const points = Array.from({ length: Math.floor(168 / stepHours) + 1 }, (_, i) => ({
      bucket: new Date(NOW - 7 * DAY + i * stepHours * 3_600_000),
      mount: '/',
      system: 'server-1',
      total_max: 1024 * GIB + (stepHours === 20 ? i % 2 : i % 9) * 1024 ** 2,
      used_max: Math.round((10 + (2 * i * stepHours) / 24) * GIB),
    }));
    await h.db.sql`INSERT INTO disk_rollups ${h.db.sql(points)}`;
    const [trend] = await readDiskTrends(h.db.sql, { now: NOW, system: 'server-1' });
    expect(trend?.growth?.bytesPerDay).toBeCloseTo(2 * GIB, -3);
  });
}

test('a swap excludes the mixed bucket and reports its short fit distinctly', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await h.db.sql`DELETE FROM disk_rollups`;
  const points = [
    { hours: -168, total: 100, used: 90 },
    { hours: -48, total: 1024, used: 90 }, // new total, old used maximum
    { hours: -47, total: 1024, used: 10 + 1 / 24 },
    { hours: -24, total: 1024, used: 11 },
    { hours: 0, total: 1024, used: 12 },
  ];
  await h.db.sql`INSERT INTO disk_rollups ${h.db.sql(
    points.map((p) => ({
      bucket: new Date(NOW + (p.hours * DAY) / 24),
      mount: '/',
      system: 'server-1',
      total_max: p.total * GIB,
      used_max: Math.round(p.used * GIB),
    })),
  )}`;
  const [trend] = await readDiskTrends(h.db.sql, { now: NOW, system: 'server-1' });
  expect(trend?.growth?.bytesPerDay).toBeCloseTo(GIB, -3);
  expect(trend?.spanMs).toBe((47 * DAY) / 24);
  const [short] = await readDiskTrends(h.db.sql, { now: NOW - DAY, system: 'server-1' });
  expect(short?.growth).toBeUndefined();
  expect(short?.sizeChanged).toBe(true);
});

test('exactly one day is enough to fit growth', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await h.db.sql`DELETE FROM disk_rollups`;
  await h.db.sql`INSERT INTO disk_rollups (system, mount, bucket, total_max, used_max)
    VALUES ('server-1', '/', ${new Date(NOW - DAY)}, ${100 * GIB}, ${10 * GIB}),
           ('server-1', '/', ${new Date(NOW)}, ${100 * GIB}, ${11 * GIB})`;
  const [trend] = await readDiskTrends(h.db.sql, { now: NOW, system: 'server-1' });
  expect(trend?.growth?.bytesPerDay).toBeCloseTo(GIB, -3);
});

test('System and Low disk pages share a replacement fit and ship only rendered trend fields', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await h.db.sql`DELETE FROM disk_rollups`;
  await h.db.sql`INSERT INTO disk_rollups (system, mount, bucket, total_max, used_max)
    VALUES ('server-1', '/', ${new Date(NOW - 7 * DAY)}, ${100 * GIB}, ${90 * GIB}),
           ('server-1', '/', ${new Date(NOW - 3 * DAY)}, ${1024 * GIB}, ${90 * GIB}),
           ('server-1', '/', ${new Date(NOW - 2 * DAY)}, ${1024 * GIB}, ${11 * GIB}),
           ('server-1', '/', ${new Date(NOW)}, ${1024 * GIB}, ${13 * GIB})`;
  await timeline(NOW).addCondition(h.db.sql, {
    kind: 'low_disk',
    level: 'note',
    raisedAt: -60,
    subject: '/',
    system: 'server-1',
  });
  const [row]: { id: string }[] = await h.db.sql`SELECT id FROM conditions WHERE kind = 'low_disk'`;
  if (row === undefined) {
    throw new Error('Expected the disk Condition.');
  }
  const system = await readSystemPage(h.db.sql, { name: 'server-1', now: NOW, range: '12h' });
  const condition = await readConditionDetail(h.db.sql, { id: row.id, name: 'server-1', now: NOW });
  expect(condition?.diskTrend?.growth?.bytesPerDay).toBeCloseTo(GIB, -3);
  expect(condition?.diskTrend).toMatchObject(system?.detail.diskTrends[0] ?? {});
  expect(Object.keys(system?.detail.diskTrends[0] ?? {}).toSorted()).toEqual([
    'growth',
    'mount',
    'sizeChanged',
    'spanMs',
  ]);
  if (condition === undefined) {
    throw new Error('Expected a Condition page.');
  }
  const quiet = await readConditionDetail(h.db.sql, {
    id: row.id,
    name: 'server-1',
    now: NOW + 10 * DAY,
  });
  if (quiet === undefined) {
    throw new Error('Expected quiet disk detail.');
  }
  expect(conditionDetailView(quiet, NOW + 10 * DAY).rate?.text).toStartWith(
    '+1.0 GiB a day over the last 2 days.',
  );
  expect(conditionDetailView(condition, NOW).rate?.text).toStartWith(
    '+1.0 GiB a day over the last 2 days.',
  );
});

test('System trend payload omits SQL diagnostic fields', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  const page = await readSystemPage(h.db.sql, { name: 'server-1', now: NOW, range: '12h' });
  expect(page?.detail.diskTrends.length).toBeGreaterThan(0);
  for (const trend of page?.detail.diskTrends ?? []) {
    expect(Object.keys(trend).toSorted()).toEqual(['growth', 'mount', 'sizeChanged', 'spanMs']);
  }
});
