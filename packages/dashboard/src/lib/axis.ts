import type { Range } from '../server/fleet-overview-types.ts';
import {
  formatClock,
  formatClockSeconds,
  formatWeekday,
  localDayNumber,
  localHourMinute,
  xPercent,
} from './time.ts';
import type { Window } from './time.ts';

export type Tick = {
  at: number;
  // Where the label sits against its tick: the first is left-aligned, the last right-aligned.
  edge: 'end' | 'middle' | 'start';
  label: string;
  // Dropped on a narrow screen to leave room.
  minor: boolean;
};

const QUARTER_HOUR_MS = 15 * 60_000;
// A round tick this close to either end, in percent of the window, would
// crowd the first label or "now".
const EDGE_CLEARANCE_PERCENT = 10;

// Round local hours that get a tick, and the multiple of them that is major.
const HOUR_STEPS: Record<Exclude<Range, '7d'>, { major: number; step: number }> = {
  '12h': { major: 4, step: 2 },
  '24h': { major: 8, step: 4 },
  '6h': { major: 2, step: 1 },
};

// The ticks along a window: the first at its start, round local times between,
// and "now" at its end. 7d ticks each local midnight, labeled by weekday.
export const axisTicks = (range: Range, window: Window, timeZone: string): Tick[] => {
  const { from, to } = window;
  const weekly = range === '7d';
  const ticks: Tick[] = [
    {
      at: from,
      edge: 'start',
      label: weekly ? formatWeekday(from, timeZone) : formatClock(from, timeZone),
      minor: false,
    },
  ];
  const first = Math.ceil((from + 1) / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  for (let at = first; at < to; at += QUARTER_HOUR_MS) {
    const percent = xPercent(at, window);
    if (percent < EDGE_CLEARANCE_PERCENT || percent > 100 - EDGE_CLEARANCE_PERCENT) {
      continue;
    }
    const { hour, minute } = localHourMinute(at, timeZone);
    if (minute !== 0) {
      continue;
    }
    if (weekly) {
      if (hour === 0) {
        ticks.push({
          at,
          edge: 'middle',
          label: formatWeekday(at, timeZone),
          minor: localDayNumber(at, timeZone) % 2 === 0,
        });
      }
    } else {
      const { major, step } = HOUR_STEPS[range];
      if (hour % step === 0) {
        ticks.push({
          at,
          edge: 'middle',
          label: formatClock(at, timeZone),
          minor: hour % major !== 0,
        });
      }
    }
  }
  ticks.push({ at: to, edge: 'end', label: 'now', minor: false });
  return ticks;
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// The most intervals a span axis shows between its ends.
const SPAN_MAX_INTERVALS = 8;
// Steps for a window up to two days, in minutes, smallest first.
const SPAN_STEPS_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720];
const SPAN_FALLBACK_STEP_MINUTES = 720;
// A longer window steps in whole local days instead.
const SPAN_STEPS_DAYS = [1, 2, 7];
const SPAN_FALLBACK_STEP_DAYS = 7;
const SPAN_MINUTE_TICKS_UP_TO_MS = 2 * DAY_MS;
// A shorter window needs seconds, or its labels repeat.
const SPAN_SECONDS_BELOW_MS = 10 * MINUTE_MS;
// The local day number of a Monday, modulo 7: 1970-01-01 was a Thursday.
const MONDAY_DAY_NUMBER = 4;

// The smallest step that keeps a window to at most SPAN_MAX_INTERVALS intervals.
const spanStep = (length: number, steps: readonly number[], fallback: number): number =>
  steps.find((step) => length / step <= SPAN_MAX_INTERVALS) ?? fallback;

// The local midnight that starts the day holding `t`.
const localMidnight = (t: number, timeZone: string): number => {
  const { hour, minute } = localHourMinute(t, timeZone);
  return Math.floor(t / MINUTE_MS) * MINUTE_MS - (hour * 60 + minute) * MINUTE_MS;
};

// A round tick between the ends of a window, or nothing if it crowds an end.
const roundTick = (at: number, window: Window, label: string, minor: boolean): Tick | undefined => {
  const percent = xPercent(at, window);
  if (percent < EDGE_CLEARANCE_PERCENT || percent > 100 - EDGE_CLEARANCE_PERCENT) {
    return undefined;
  }
  return { at, edge: 'middle', label, minor };
};

// Ticks at the local midnights of a window of days: each day, every second
// day, or each Monday, labeled by weekday.
const dayTicks = (window: Window, timeZone: string): Tick[] => {
  const { from, to } = window;
  const step = spanStep((to - from) / DAY_MS, SPAN_STEPS_DAYS, SPAN_FALLBACK_STEP_DAYS);
  const offset = step === 7 ? MONDAY_DAY_NUMBER : 0;
  const ticks: Tick[] = [];
  let midnight = localMidnight(from, timeZone);
  while (midnight < to) {
    const days = localDayNumber(midnight, timeZone) - offset;
    if (midnight > from && days % step === 0) {
      const tick = roundTick(
        midnight,
        window,
        formatWeekday(midnight, timeZone),
        (days / step) % 2 === 1,
      );
      if (tick !== undefined) {
        ticks.push(tick);
      }
    }
    // Jump to the middle of the next day, then back to its midnight, so a
    // 23 or 25 hour day does not skip or repeat one.
    midnight = localMidnight(midnight + 36 * HOUR_MS, timeZone);
  }
  return ticks;
};

// Ticks at the round local times of a window of up to two days.
const clockTicks = (window: Window, timeZone: string, label: (t: number) => string): Tick[] => {
  const { from, to } = window;
  const stepMinutes = spanStep(
    (to - from) / MINUTE_MS,
    SPAN_STEPS_MINUTES,
    SPAN_FALLBACK_STEP_MINUTES,
  );
  // Zone offsets are whole quarter hours, so a round local time is on this grid.
  const gridMs = (stepMinutes < 15 ? 1 : 15) * MINUTE_MS;
  const ticks: Tick[] = [];
  for (let at = Math.ceil((from + 1) / gridMs) * gridMs; at < to; at += gridMs) {
    const { hour, minute } = localHourMinute(at, timeZone);
    const minuteOfDay = hour * 60 + minute;
    if (minuteOfDay % stepMinutes === 0) {
      const tick = roundTick(at, window, label(at), (minuteOfDay / stepMinutes) % 2 === 1);
      if (tick !== undefined) {
        ticks.push(tick);
      }
    }
  }
  return ticks;
};

// The ticks along an arbitrary window, such as a Session's span: its start and
// its end, and round local times between, spaced so about 8 labels fit. Up to
// two days the ends are clock times (with seconds under 10 minutes) and the
// round times are clock times, every other one minor. Longer windows tick local
// midnights by weekday, and the ends add the weekday to their clock time.
export const spanTicks = (window: Window, timeZone: string): Tick[] => {
  const { from, to } = window;
  const length = to - from;
  const daily = length > SPAN_MINUTE_TICKS_UP_TO_MS;
  const clock = length < SPAN_SECONDS_BELOW_MS ? formatClockSeconds : formatClock;
  const endLabel = (t: number): string =>
    daily ? `${formatWeekday(t, timeZone)} ${formatClock(t, timeZone)}` : clock(t, timeZone);
  return [
    { at: from, edge: 'start', label: endLabel(from), minor: false },
    ...(daily
      ? dayTicks(window, timeZone)
      : clockTicks(window, timeZone, (t) => clock(t, timeZone))),
    { at: to, edge: 'end', label: endLabel(to), minor: false },
  ];
};
