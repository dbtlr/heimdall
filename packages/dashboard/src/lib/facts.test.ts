import { describe, expect, test } from 'bun:test';

import { diskUsage, formatLoad } from './facts.ts';

const GIB = 1024 ** 3;
const TIB = 1024 ** 4;

describe('diskUsage', () => {
  test('gives used of total in GiB, with the percent used', () => {
    expect(diskUsage({ mount: '/', totalBytes: 931 * GIB, usedBytes: 412 * GIB })).toEqual({
      nearlyFull: false,
      percent: 44,
      text: '412 of 931 GiB',
    });
  });

  test('reads in TiB from a terabyte up, and keeps a decimal below 100', () => {
    expect(diskUsage({ mount: '/data', totalBytes: 3.6 * TIB, usedBytes: 2.1 * TIB })).toEqual({
      nearlyFull: false,
      percent: 58,
      text: '2.1 of 3.6 TiB',
    });
    expect(diskUsage({ mount: '/boot', totalBytes: 0.5 * GIB, usedBytes: 0.2 * GIB }).text).toBe(
      '0.2 of 0.5 GiB',
    );
  });

  // The Hub raises its low disk Condition below 10% free.
  test.each([
    [89, false],
    [90, false],
    [90.5, true],
    [97, true],
  ])(
    'is nearly full below 10%% free, as the Hub judges low disk: %p%% used is %p',
    (used, full) => {
      expect(
        diskUsage({ mount: '/', totalBytes: 100 * GIB, usedBytes: used * GIB }).nearlyFull,
      ).toBe(full);
    },
  );

  test('is full for a mount used past its size, with the bar held at 100%', () => {
    expect(diskUsage({ mount: '/', totalBytes: 10 * GIB, usedBytes: 12 * GIB })).toMatchObject({
      nearlyFull: true,
      percent: 100,
    });
  });

  test('has nothing to judge for a mount with no size', () => {
    expect(diskUsage({ mount: '/proc', totalBytes: 0, usedBytes: 0 })).toEqual({
      nearlyFull: false,
      percent: 0,
      text: '0 of 0 GiB',
    });
  });
});

test('a load average reads to two decimals', () => {
  expect(formatLoad(0.4)).toBe('0.40');
  expect(formatLoad(12.345)).toBe('12.35');
});
