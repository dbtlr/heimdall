// Times and positions on the overview's time axis. Every time is epoch
// milliseconds, formatted in the zone the caller names: the viewer's own, known
// only in the browser.

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatter = (timeZone: string, options: Intl.DateTimeFormatOptions) => {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let found = formatters.get(key);
  if (found === undefined) {
    found = new Intl.DateTimeFormat('en-GB', { ...options, timeZone });
    formatters.set(key, found);
  }
  return found;
};

// The time of day as 24-hour "HH:MM".
export const formatClock = (t: number, timeZone: string): string =>
  formatter(timeZone, { hour: '2-digit', hourCycle: 'h23', minute: '2-digit' }).format(t);

// The time of day as 24-hour "HH:MM:SS".
export const formatClockSeconds = (t: number, timeZone: string): string =>
  formatter(timeZone, {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    second: '2-digit',
  }).format(t);

// The weekday as "Mon".
export const formatWeekday = (t: number, timeZone: string): string =>
  formatter(timeZone, { weekday: 'short' }).format(t);

type LocalDay = { day: number; month: number; year: number };

const localDay = (t: number, timeZone: string): LocalDay => {
  const parts = formatter(timeZone, { day: 'numeric', month: 'numeric', year: 'numeric' })
    .formatToParts(t)
    .reduce<Record<string, number>>((found, part) => {
      found[part.type] = Number(part.value);
      return found;
    }, {});
  return { day: parts.day ?? 1, month: parts.month ?? 1, year: parts.year ?? 1970 };
};

// How many days since 1970-01-01 the local calendar day of `t` is.
export const localDayNumber = (t: number, timeZone: string): number => {
  const { day, month, year } = localDay(t, timeZone);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
};

// The local hour (0 to 23) and minute of `t`.
export const localHourMinute = (t: number, timeZone: string): { hour: number; minute: number } => {
  const [hour = '0', minute = '0'] = formatClock(t, timeZone).split(':');
  return { hour: Number(hour), minute: Number(minute) };
};

// "HH:MM" for a time on the same local day as `now`, else "Mon 14:02".
export const formatWhen = (t: number, now: number, timeZone: string): string =>
  localDayNumber(t, timeZone) === localDayNumber(now, timeZone)
    ? formatClock(t, timeZone)
    : `${formatWeekday(t, timeZone)} ${formatClock(t, timeZone)}`;

// How a time is written: a clock time, with or without seconds, a weekday, or
// `when`, the clock time or the weekday and clock time relative to `now`.
export type TimeFormat =
  | { format: 'clock' | 'clockSeconds' | 'weekday' }
  | { format: 'when'; now: number };

// `t` written as `spec` says, in `timeZone`.
export const formatTime = (t: number, timeZone: string, spec: TimeFormat): string => {
  switch (spec.format) {
    case 'clock': {
      return formatClock(t, timeZone);
    }
    case 'clockSeconds': {
      return formatClockSeconds(t, timeZone);
    }
    case 'weekday': {
      return formatWeekday(t, timeZone);
    }
    case 'when': {
      return formatWhen(t, spec.now, timeZone);
    }
    default: {
      const _exhaustive: never = spec;
      return _exhaustive;
    }
  }
};

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// "7 h 33 min", or "7 h" when the smaller unit is zero.
const pair = (big: number, bigUnit: string, small: number, smallUnit: string) =>
  small === 0
    ? `${String(big)} ${bigUnit}`
    : `${String(big)} ${bigUnit} ${String(small)} ${smallUnit}`;

// A length of time in its largest two units, the smaller dropped when zero:
// "20 s", "4 min", "7 h 33 min", "1 d 2 h".
export const formatSpan = (ms: number): string => {
  if (ms < MINUTE_MS) {
    return `${String(Math.round(ms / SECOND_MS))} s`;
  }
  if (ms < HOUR_MS) {
    return `${String(Math.floor(ms / MINUTE_MS))} min`;
  }
  if (ms < DAY_MS) {
    return pair(Math.floor(ms / HOUR_MS), 'h', Math.floor((ms % HOUR_MS) / MINUTE_MS), 'min');
  }
  return pair(Math.floor(ms / DAY_MS), 'd', Math.floor((ms % DAY_MS) / HOUR_MS), 'h');
};

// A cost as "$4.05", or "cost unknown" when a request was unpriced.
export const formatCost = (costUsd: number | undefined): string =>
  costUsd === undefined ? 'cost unknown' : `$${costUsd.toFixed(2)}`;

export type Window = { from: number; to: number };

// How far across the window `t` falls, in percent: 0 at `from`, 100 at `to`.
export const xPercent = (t: number, { from, to }: Window): number =>
  ((t - from) / (to - from)) * 100;

// Whether `t` is inside the window, edges included.
export const inWindow = (t: number, { from, to }: Window): boolean => t >= from && t <= to;

// The left edge and width, in percent of the window, of the span `start` to
// `end` clipped to the window.
export const spanBox = (
  { end, start }: { end: number; start: number },
  window: Window,
): { left: number; width: number } => {
  const left = xPercent(Math.max(start, window.from), window);
  const right = xPercent(Math.min(end, window.to), window);
  return { left, width: Math.max(0, right - left) };
};
