// The buckets the System page's 30 d and 1 y ranges are drawn in, in the
// viewer's time zone, as the Home and Agents pages count days: a local day
// each over a year, and 3 hours of the local clock within each day over 30
// days. Each list is a run of edges in epoch milliseconds, earliest first, and
// a bucket runs from one edge up to the next, so a day a clock change makes 23
// or 25 hours long is one bucket all the same.

import type { LongRange } from '../server/fleet-overview-types.ts';

// The edges of a long range: `buckets` for the Vitals and the processes, `days`
// for the cost bars, and `changes` for the change counts, local days over 30 d
// and weeks from Monday over 1 y. Each list's first bucket holds the range's
// start and its last holds its end, so each bucket is read whole and every
// chart starts its first bucket at the same edge.
export type LongEdges = { buckets: number[]; changes: number[]; days: number[] };

// The hours of the local clock a 30 d bucket starts at.
const BUCKET_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

// The bucket of `edges` that holds `t`, or undefined for a time before the
// first edge or at or after the last.
export const spanHolding = (
  edges: readonly number[],
  t: number,
): { end: number; start: number } | undefined => {
  let [low, high] = [0, edges.length - 1];
  if (high < 1 || t < (edges[0] ?? 0) || t >= (edges[high] ?? 0)) {
    return undefined;
  }
  // The last edge at or before `t`.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if ((edges[middle] ?? 0) <= t) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return { end: edges[low + 1] ?? 0, start: edges[low] ?? 0 };
};

// Each bucket of `edges` as its start and end.
export const edgeSpans = (edges: readonly number[]): { end: number; start: number }[] =>
  edges.slice(1).map((end, index) => ({ end, start: edges[index] ?? end }));

// The edges of `range` from `from` to `to` in `timeZone`. A day starts at its
// first instant, as on the Agents page, and a 3-hour bucket at its clock time,
// or the instant after when a clock change skips that time.
export const longEdges = (
  range: LongRange,
  from: number,
  to: number,
  timeZone: string,
): LongEdges => {
  const dateOf = (ms: number) =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone).toPlainDate();
  const startOf = (day: Temporal.PlainDate) =>
    day.toZonedDateTime({ timeZone }).startOfDay().epochMilliseconds;
  const [first, last] = [dateOf(from), dateOf(to)];
  const dates: Temporal.PlainDate[] = [];
  for (let day = first; Temporal.PlainDate.compare(day, last) <= 0; day = day.add({ days: 1 })) {
    dates.push(day);
  }
  const days = [...dates.map(startOf), startOf(last.add({ days: 1 }))];
  if (range === '1y') {
    const weeks: number[] = [];
    let monday = first.subtract({ days: first.dayOfWeek - 1 });
    for (; Temporal.PlainDate.compare(monday, last) <= 0; monday = monday.add({ days: 7 })) {
      weeks.push(startOf(monday));
    }
    weeks.push(startOf(monday));
    return { buckets: days, changes: weeks, days };
  }
  const hours: number[] = [];
  for (const day of dates) {
    for (const hour of BUCKET_HOURS) {
      const start =
        hour === 0
          ? startOf(day)
          : day.toZonedDateTime({ plainTime: new Temporal.PlainTime(hour), timeZone })
              .epochMilliseconds;
      if (start > (hours.at(-1) ?? Number.NEGATIVE_INFINITY)) {
        hours.push(start);
      }
    }
  }
  hours.push(days.at(-1) ?? to);
  // From the bucket holding `from` to the one holding `to`.
  const firstIndex = hours.findLastIndex((edge) => edge <= from);
  const lastIndex = hours.findIndex((edge) => edge > to);
  return {
    buckets: hours.slice(Math.max(0, firstIndex), lastIndex + 1),
    changes: days,
    days,
  };
};
