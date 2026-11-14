// A Service's availability over the 90 days the Hub keeps its stops: one cell
// per day, up, restarted, down, or with no Reports from the System, and the
// share of the time the Service was up. A stop is a down stop when the Service
// down Condition was open over it, and a restart otherwise.

import type { ServiceDownTransition, ServiceStop } from '../server/service-detail-types.ts';
import type { Window } from './time.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// The Hub keeps stops for this long, and the strip spans it.
export const WINDOW_DAYS = 90;
export const WINDOW_MS = WINDOW_DAYS * DAY_MS;

export type DayState = 'down' | 'quiet' | 'restarted' | 'up';

export type StripDay = { from: number; state: DayState };

export type Availability = {
  days: StripDay[];
  // How many times the Service down Condition was raised, and how many stops
  // were restarts, in the window.
  downPeriods: number;
  restarts: number;
  // The share of the time with Reports that the Service was up, in percent;
  // undefined when no day had Reports.
  percent: number | undefined;
};

// `window` is the 90 days before `now`; day 0 starts at its `from`.
export const stripWindow = (now: number): Window => ({ from: now - WINDOW_MS, to: now });

// The span a stop lasted: until it ran again, until `now` while still under
// way, or no time at all when its end is unknown.
export const stopSpan = (stop: ServiceStop, now: number): Window => {
  const from = Date.parse(stop.stoppedAt);
  if (stop.startedAt !== null) {
    return { from, to: Math.max(from, Date.parse(stop.startedAt)) };
  }
  return { from, to: stop.ongoing ? Math.max(from, now) : from };
};

// The spans the Service down Condition was open, a raise with its clear, or
// with `now` while still open.
export const downSpans = (downs: readonly ServiceDownTransition[], now: number): Window[] => {
  const clearedAt = new Map(
    downs.filter(({ kind }) => kind === 'cleared').map(({ at, condition }) => [condition, at]),
  );
  return downs
    .filter(({ kind }) => kind === 'raised')
    .map(({ at, condition }) => ({ from: at, to: Math.max(at, clearedAt.get(condition) ?? now) }));
};

const overlaps = (a: Window, b: Window): boolean => a.from <= b.to && b.from <= a.to;

// Whether the Service down Condition was open over the stop, or it is still down.
export const isDownStop = (stop: ServiceStop, downs: readonly Window[], now: number): boolean => {
  const span = stopSpan(stop, now);
  return (stop.ongoing && stop.startedAt === null) || downs.some((down) => overlaps(span, down));
};

// The total length of `spans` inside `window`, overlaps counted once.
const coveredMs = (spans: readonly Window[], window: Window): number => {
  const clipped = spans
    .map(({ from, to }) => ({ from: Math.max(from, window.from), to: Math.min(to, window.to) }))
    .filter(({ from, to }) => to > from)
    .toSorted((a, b) => a.from - b.from);
  let total = 0;
  let end = -Infinity;
  for (const span of clipped) {
    total += Math.max(0, span.to - Math.max(span.from, end));
    end = Math.max(end, span.to);
  }
  return total;
};

// The cells and totals for the 90 days before `now`. `reportDays` holds the
// index of each day, counted from the window's start, in which the System sent
// Vitals. Stops and Service down spans count even on a day with none.
export const availability = ({
  downs,
  now,
  reportDays,
  stops,
}: {
  downs: readonly ServiceDownTransition[];
  now: number;
  reportDays: readonly number[];
  stops: readonly ServiceStop[];
}): Availability => {
  const window = stripWindow(now);
  const reported = new Set(reportDays);
  const downSpansNow = downSpans(downs, now);
  const stopSpans = stops.map((stop) => ({
    down: isDownStop(stop, downSpansNow, now),
    span: stopSpan(stop, now),
  }));
  const days = Array.from({ length: WINDOW_DAYS }, (_, index): StripDay => {
    const day = { from: window.from + index * DAY_MS, to: window.from + (index + 1) * DAY_MS };
    const touching = (span: Window) => span.from < day.to && span.to >= day.from;
    let state: DayState = 'up';
    if (downSpansNow.some(touching) || stopSpans.some(({ down, span }) => down && touching(span))) {
      state = 'down';
    } else if (stopSpans.some(({ span }) => touching(span))) {
      state = 'restarted';
    } else if (!reported.has(index)) {
      state = 'quiet';
    }
    return { from: day.from, state };
  });
  const quiet = days.filter(({ state }) => state === 'quiet');
  const observedMs = WINDOW_MS - quiet.length * DAY_MS;
  const downMs = coveredMs([...downSpansNow, ...stopSpans.map(({ span }) => span)], window);
  return {
    days,
    downPeriods: downSpansNow.filter((span) => span.to >= window.from).length,
    percent: observedMs <= 0 ? undefined : Math.max(0, (1 - downMs / observedMs) * 100),
    restarts: stopSpans.filter(({ down, span }) => !down && span.from >= window.from).length,
  };
};

// The percentage cut, never rounded up to 100 or to the next hundredth:
// "99.98%". Undefined when there is none to show.
export const percentWords = (percent: number | undefined): string | undefined =>
  percent === undefined ? undefined : `${(Math.floor(percent * 100) / 100).toFixed(2)}%`;
