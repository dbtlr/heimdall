import { describe, expect, test } from 'bun:test';

import { edgeSpans, longEdges, spanHolding } from './bucket-edges.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const lengths = (edges: readonly number[]) => edgeSpans(edges).map(({ end, start }) => end - start);

describe('longEdges', () => {
  test('a year in Berlin is local days from the one holding its start, 23 and 25 hours across the clock changes', () => {
    const now = Date.UTC(2026, 9, 6, 12);
    const { buckets, changes, days } = longEdges('1y', now - 365 * DAY, now, 'Europe/Berlin');

    expect(buckets).toEqual(days);
    // Midnight in Berlin on 6 Oct 2025, CEST, to midnight after 6 Oct 2026.
    expect(buckets[0]).toBe(Date.UTC(2025, 9, 5, 22));
    expect(buckets.at(-1)).toBe(Date.UTC(2026, 9, 6, 22));
    expect(buckets).toContain(Date.UTC(2025, 9, 25, 22));
    expect(buckets).toContain(Date.UTC(2025, 9, 26, 23));
    const spans = lengths(buckets);
    expect(spans.filter((ms) => ms === 25 * HOUR)).toHaveLength(1);
    expect(spans.filter((ms) => ms === 23 * HOUR)).toHaveLength(1);
    expect(spans.every((ms) => ms >= 23 * HOUR && ms <= 25 * HOUR)).toBe(true);
    // Weeks from the Monday on or before 6 Oct 2025, itself a Monday.
    expect(changes[0]).toBe(Date.UTC(2025, 9, 5, 22));
    expect(changes[1]).toBe(Date.UTC(2025, 9, 12, 22));
    expect(changes.at(-1)).toBe(Date.UTC(2026, 9, 11, 22));
  });

  test('30 days in Los Angeles are 3-hour buckets of the local clock, from the one holding the start', () => {
    const now = Date.UTC(2026, 10, 15, 12);
    const { buckets, changes, days } = longEdges('30d', now - 30 * DAY, now, 'America/Los_Angeles');

    // The start, 16 Oct 2026 12:00 UTC, is 05:00 PDT, in the bucket from 03:00.
    expect(buckets[0]).toBe(Date.UTC(2026, 9, 16, 10));
    // 15 Nov 2026 12:00 UTC is 04:00 PST, in the bucket from 03:00 to 06:00.
    expect(buckets.at(-2)).toBe(Date.UTC(2026, 10, 15, 11));
    expect(buckets.at(-1)).toBe(Date.UTC(2026, 10, 15, 14));
    // 1 Nov 2026 has 25 hours: its first bucket, midnight PDT to 03:00 PST, has 4.
    expect(buckets).toContain(Date.UTC(2026, 10, 1, 7));
    expect(buckets).toContain(Date.UTC(2026, 10, 1, 11));
    expect(buckets).not.toContain(Date.UTC(2026, 10, 1, 10));
    expect(lengths(buckets).filter((ms) => ms !== 3 * HOUR)).toEqual([4 * HOUR]);
    expect(changes).toEqual(days);
    expect(days[0]).toBe(Date.UTC(2026, 9, 16, 7));
    expect(days.at(-1)).toBe(Date.UTC(2026, 10, 16, 8));
  });

  test('30 days in Berlin across the spring change give the night bucket 2 hours', () => {
    const now = Date.UTC(2026, 3, 10, 12);
    const { buckets } = longEdges('30d', now - 30 * DAY, now, 'Europe/Berlin');

    // 29 Mar 2026: midnight CET to 03:00 CEST is 2 hours.
    expect(buckets).toContain(Date.UTC(2026, 2, 28, 23));
    expect(buckets).toContain(Date.UTC(2026, 2, 29, 1));
    expect(lengths(buckets).filter((ms) => ms !== 3 * HOUR)).toEqual([2 * HOUR]);
  });
});

describe('spanHolding', () => {
  test('finds the bucket an instant falls in, and none outside the edges', () => {
    const edges = [0, 10, 25, 30];

    expect(spanHolding(edges, 0)).toEqual({ end: 10, start: 0 });
    expect(spanHolding(edges, 24)).toEqual({ end: 25, start: 10 });
    expect(spanHolding(edges, 25)).toEqual({ end: 30, start: 25 });
    expect(spanHolding(edges, 30)).toBeUndefined();
    expect(spanHolding(edges, -1)).toBeUndefined();
    expect(spanHolding([5], 5)).toBeUndefined();
  });
});
