import { expect, test } from 'bun:test';

import { growthWords, reachWords } from './disk-growth.ts';

const GIB = 1024 ** 3;
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
