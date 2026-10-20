import { expect, test } from 'bun:test';

import { duration, parseDuration } from './duration.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test.each([
  ['30m', 30 * MINUTE],
  ['2h', 2 * HOUR],
  ['1d', DAY],
  ['1h30m', HOUR + 30 * MINUTE],
  ['1d12h', DAY + 12 * HOUR],
  ['90m', 90 * MINUTE],
  ['365d', 365 * DAY],
])('%p lasts the time it spells', (text, ms) => {
  expect(parseDuration(text)).toBe(ms);
});

test.each([
  [''],
  ['0m'],
  ['0h0m'],
  ['2'],
  ['h'],
  ['2 h'],
  ['2H'],
  ['-2h'],
  ['1.5h'],
  ['2s'],
  ['2w'],
  ['1h2h'],
  ['30m1h'],
  ['1h30'],
  ['99999999999999999999d'],
  ['99999999d'],
  ['366d'],
  ['365d1m'],
])('%p is no duration', (text) => {
  expect(parseDuration(text)).toBeUndefined();
});

test('the validator accepts what parses, keeping the token, and rejects the rest with an example', () => {
  const schema = duration()['~standard'];

  expect(schema.validate('1h30m')).toEqual({ value: '1h30m' });
  const rejected = schema.validate('soon');
  expect(rejected).toEqual({
    issues: [expect.objectContaining({ message: expect.stringContaining('2h') })],
  });
});
