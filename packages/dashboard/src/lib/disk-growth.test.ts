import { expect, test } from 'bun:test';

import { diskGrowth, growthWords, reachWords } from './disk-growth.ts';

const GIB = 1024 ** 3;
const DAY = 86_400_000;

// One point a 5-minute bucket, used bytes growing `perDay` bytes a day.
const steady = (days: number, perDay: number, startUsed = 100 * GIB, total = 200 * GIB) =>
  Array.from({ length: days * 288 + 1 }, (_, index) => ({
    t: index * 300_000,
    totalBytes: total,
    usedBytes: startUsed + (perDay * index * 300_000) / DAY,
  }));

test('fits a straight line through the points to find bytes a day and days until full', () => {
  const growth = diskGrowth(steady(7, 2 * GIB));
  expect(growth?.bytesPerDay).toBeCloseTo(2 * GIB, -3);
  // 100 GiB used at the start, 14 GiB more by day 7: 86 GiB free at 2 GiB a day.
  expect(growth?.daysUntilFull).toBeCloseTo(43, 3);
});

test('a noisy series still gets its trend', () => {
  const points = steady(7, GIB);
  for (const [index, point] of points.entries()) {
    point.usedBytes += (index % 2 === 0 ? 0.3 : -0.3) * GIB;
  }
  expect(diskGrowth(points)?.bytesPerDay).toBeCloseTo(GIB, -8);
});

test('is not computable from fewer than two points', () => {
  expect(diskGrowth([])).toBeUndefined();
  expect(diskGrowth([{ t: 0, totalBytes: 10, usedBytes: 5 }])).toBeUndefined();
});

test('is not computable from less than a day of points', () => {
  expect(diskGrowth(steady(0, GIB).slice(0, 200))).toBeUndefined();
});

test('a flat or shrinking disk grows nowhere, so is never full', () => {
  expect(diskGrowth(steady(3, 0))?.daysUntilFull).toBeUndefined();
  const shrinking = diskGrowth(steady(3, -GIB));
  expect(shrinking?.bytesPerDay).toBeLessThan(0);
  expect(shrinking?.daysUntilFull).toBeUndefined();
});

test('a full disk is full in no days', () => {
  const points = steady(3, GIB, 200 * GIB);
  expect(diskGrowth(points)?.daysUntilFull).toBe(0);
});

test('says growth in GiB a day, or in MiB below a GiB', () => {
  expect(growthWords(2.1 * GIB)).toBe('+2.1 GiB a day');
  expect(growthWords(38 * GIB)).toBe('+38 GiB a day');
  expect(growthWords(0.1 * GIB)).toBe('+102 MiB a day');
});

test('says when a mark is reached, capped at a year', () => {
  expect(reachWords(0)).toBe('now');
  expect(reachWords(0.4)).toBe('in under a day');
  expect(reachWords(1.2)).toBe('in about 1 day');
  expect(reachWords(18)).toBe('in about 18 days');
  expect(reachWords(883_932)).toBe('in over a year');
});
