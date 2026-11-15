// A span of time in epoch milliseconds, from `start` to `end`.
export type Interval = { end: number; start: number };

// How much time the intervals cover, counting time that several cover once.
export const unionMs = (intervals: readonly Interval[]): number => {
  let total = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const { end, start } of intervals.toSorted((a, b) => a.start - b.start)) {
    if (end > reach) {
      total += end - Math.max(start, reach);
      reach = end;
    }
  }
  return total;
};

type SessionInterval = Interval & {
  harness: string;
  sessionId: string;
  source: string;
  system: string;
};

const sameSession = (a: SessionInterval, b: SessionInterval) =>
  a.system === b.system &&
  a.harness === b.harness &&
  a.source === b.source &&
  a.sessionId === b.sessionId;

// One System's intervals stacked into rows, so no two that overlap share a
// row: each goes into the first row free at its start. A Session's intervals
// closer than `joinMs` draw as one block first, as long as no other Session's
// interval starts between them, so a lane at 30 days holds blocks wide enough
// to see and tap.
export const laneRows = <T extends SessionInterval>(
  intervals: readonly T[],
  joinMs: number,
): T[][] => {
  const sorted = intervals.toSorted((a, b) => a.start - b.start);
  const joined: T[] = [];
  for (const interval of sorted) {
    const last = joined.at(-1);
    if (last !== undefined && sameSession(last, interval) && interval.start - last.end < joinMs) {
      joined[joined.length - 1] = { ...last, end: Math.max(last.end, interval.end) };
    } else {
      joined.push(interval);
    }
  }
  const rows: T[][] = [];
  for (const interval of joined) {
    const row = rows.find(
      (candidate) => (candidate.at(-1)?.end ?? Number.NEGATIVE_INFINITY) <= interval.start,
    );
    if (row === undefined) {
      rows.push([interval]);
    } else {
      row.push(interval);
    }
  }
  return rows;
};

// Whether a project name can lead to its page. The empty name is the key of
// Sessions with no working directory, and TanStack Router leaves `.` and `..`
// unencoded in a path, where the browser resolves them to another page.
export const linkableProject = (name: string | undefined): name is string =>
  name !== undefined && name !== '' && name !== '.' && name !== '..';
