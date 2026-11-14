// A Service's availability over the 90 days the Hub keeps its stops: one cell
// per local calendar day, up, restarted, down, or with no Reports from the
// System, and over the 90 days before now the share of the time the Service was
// up. A stop is a down stop when the Service down Condition was open over it,
// and a stop it came back from otherwise.

import type { ServiceDownTransition, ServiceStop } from '../server/service-detail-types.ts';
import { localMidnight } from './time.ts';
import type { Window } from './time.ts';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// The Hub keeps stops for this long, and the strip spans as many days.
export const WINDOW_DAYS = 90;
export const WINDOW_MS = WINDOW_DAYS * DAY_MS;

// The earliest time the page reads the Service down Conditions and Reports
// from: a day before the 90, so the strip's first local day is whole in any zone.
export const historyFrom = (now: number): number => now - WINDOW_MS - DAY_MS;

export type DayState = 'down' | 'quiet' | 'restarted' | 'up';

// One local calendar day of the strip, from its midnight to the next.
export type StripDay = Window & { state: DayState };

export type AvailabilityTotals = {
  // How many times the Service down Condition was open in the 90 days before
  // now, and how many other stops began in them.
  downPeriods: number;
  otherStops: number;
  // The share of the time the Hub knows about, from Reports or from the
  // Service being stopped, that the Service was up, in percent; undefined
  // when it knows of none.
  percent: number | undefined;
};

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

// Whether `span` falls in the half-open `day`: it runs into the day, or, when
// it lasted no time, it happened in it. A span that ends at the day's start
// does not touch it.
const touches = (span: Window, day: Window): boolean =>
  span.from < day.to && (span.to > day.from || span.from >= day.from);

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

type Evidence = {
  downs: readonly ServiceDownTransition[];
  now: number;
  // The spans in which the System sent Vitals, in time order, each a run of
  // 5-minute rollup buckets.
  reported: readonly Window[];
  stops: readonly ServiceStop[];
};

// The end of the UTC day holding `t`: where an unknown end falls back to when
// the percentage, which needs no time zone, has no better.
const utcDayEnd = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS + DAY_MS;

// The Hub's Vitals rollup bucket, the unit the `reported` spans are made of.
const BUCKET_MS = 5 * 60_000;

// When the System next reported after `t`: the start of the next 5-minute
// bucket holding its Vitals, within the span `t` falls in while the System
// kept reporting, else the start of the next span. Undefined when none came.
const nextReport = (reported: readonly Window[], t: number): number | undefined => {
  for (const { from, to } of reported) {
    if (from > t) {
      return from;
    }
    const next = from + (Math.floor((t - from) / BUCKET_MS) + 1) * BUCKET_MS;
    if (next < to) {
      return next;
    }
  }
  return undefined;
};

// What a stop cost: its own span, or, when its end is unknown (the Service
// ran again, but the Hub never heard when), from the stop to the System's next
// Report, or to `dayEnd` of the stop when none came, never past now. A
// finished stop whose end is lost is downtime, not no time at all.
const downtimeSpan = (
  stop: ServiceStop,
  { now, reported }: Evidence,
  dayEnd: (t: number) => number,
): Window => {
  const span = stopSpan(stop, now);
  if (stop.startedAt !== null || stop.ongoing) {
    return span;
  }
  const next = nextReport(reported, span.from);
  return { from: span.from, to: Math.min(now, next ?? dayEnd(span.from)) };
};

const spansOf = (evidence: Evidence, dayEnd: (t: number) => number) => {
  const { downs, now, stops } = evidence;
  const down = downSpans(downs, now);
  return {
    down,
    stops: stops.map((stop) => ({
      down: isDownStop(stop, down, now),
      span: downtimeSpan(stop, evidence, dayEnd),
    })),
  };
};

// The counts and the percentage over the 90 days before `now`, which need no
// time zone: a stop of unknown end with no later Report ends at the UTC day's end.
export const availabilityTotals = (evidence: Evidence): AvailabilityTotals => {
  const window = { from: evidence.now - WINDOW_MS, to: evidence.now };
  const spans = spansOf(evidence, utcDayEnd);
  const stopped = [...spans.down, ...spans.stops.map(({ span }) => span)];
  const knownMs = coveredMs([...evidence.reported, ...stopped], window);
  return {
    downPeriods: spans.down.filter((span) => span.to > window.from).length,
    otherStops: spans.stops.filter(({ down, span }) => !down && span.from >= window.from).length,
    percent: knownMs <= 0 ? undefined : (1 - coveredMs(stopped, window) / knownMs) * 100,
  };
};

// The 90 local calendar days in `timeZone` that end with today, oldest first.
// Each starts at its own midnight, so a 23 or 25 hour day keeps its length.
export const stripCalendar = (now: number, timeZone: string): Window[] => {
  const starts = [localMidnight(now, timeZone)];
  while (starts.length < WINDOW_DAYS) {
    starts.unshift(localMidnight((starts[0] ?? now) - 12 * HOUR_MS, timeZone));
  }
  return starts.map((from, index) => ({
    from,
    to: starts[index + 1] ?? localMidnight(from + 36 * HOUR_MS, timeZone),
  }));
};

// The strip's cells: each local day of the 90 in `timeZone` ending today, down
// when the Service down Condition was open or a down stop fell in it, else
// restarted when a stop did, else quiet when the System sent no Vitals in it,
// else up. Stops and Service down spans count even on a day with no Vitals.
export const stripDays = (evidence: Evidence & { timeZone: string }): StripDay[] => {
  const spans = spansOf(evidence, (t) =>
    localMidnight(localMidnight(t, evidence.timeZone) + 36 * HOUR_MS, evidence.timeZone),
  );
  return stripCalendar(evidence.now, evidence.timeZone).map((day): StripDay => {
    const touching = (span: Window) => touches(span, day);
    let state: DayState = 'up';
    if (spans.down.some(touching) || spans.stops.some(({ down, span }) => down && touching(span))) {
      state = 'down';
    } else if (spans.stops.some(({ span }) => touching(span))) {
      state = 'restarted';
    } else if (!evidence.reported.some(touching)) {
      state = 'quiet';
    }
    return { from: day.from, state, to: day.to };
  });
};

// The percentage cut, never rounded up to 100 or to the next hundredth:
// "99.98%". Undefined when there is none to show.
export const percentWords = (percent: number | undefined): string | undefined =>
  percent === undefined ? undefined : `${(Math.floor(percent * 100) / 100).toFixed(2)}%`;
