import { describe, expect, test } from 'bun:test';

import { bucketFor } from './bucket-width.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('bucketFor', () => {
  test('widens with the span, to 1 hour by 90 hours', () => {
    expect(bucketFor(0)).toBe(MINUTE);
    expect(bucketFor(90 * MINUTE)).toBe(MINUTE);
    expect(bucketFor(91 * MINUTE)).toBe(2 * MINUTE);
    expect(bucketFor(3 * HOUR)).toBe(2 * MINUTE);
    expect(bucketFor(3 * HOUR + MINUTE)).toBe(5 * MINUTE);
    expect(bucketFor(15 * HOUR)).toBe(10 * MINUTE);
    expect(bucketFor(45 * HOUR)).toBe(30 * MINUTE);
    expect(bucketFor(90 * HOUR)).toBe(HOUR);
  });

  test('grows through hours that divide a day, then whole days, so every bucket starts on the page grid', () => {
    expect(bucketFor(90 * HOUR + MINUTE)).toBe(2 * HOUR);
    expect(bucketFor(200 * HOUR)).toBe(3 * HOUR);
    expect(bucketFor(400 * HOUR)).toBe(6 * HOUR);
    expect(bucketFor(1500 * HOUR)).toBe(24 * HOUR);
    expect(bucketFor(2200 * HOUR)).toBe(48 * HOUR);
  });

  test('covers the span in the number of buckets the caller allows', () => {
    expect(bucketFor(3 * HOUR, 180)).toBe(MINUTE);
    expect(bucketFor(3 * HOUR + MINUTE, 180)).toBe(2 * MINUTE);
    expect(bucketFor(365 * 24 * HOUR, 180)).toBe(3 * 24 * HOUR);
  });
});
