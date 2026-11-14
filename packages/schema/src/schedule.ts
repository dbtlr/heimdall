import type { JobRecord } from './records.ts';

type CalendarEntry = JobRecord['schedule'][number];

// How many days either search looks through before it gives up: a little over
// four years, so an entry for 29 February still finds a leap day.
const MAX_DAYS_SEARCHED = 1500;

const DAY_MS = 86_400_000;

// Whether `entry` fires on `date`. As in cron, an entry that names both a day
// of the month and a weekday fires on either, and the month always applies.
// launchd fires on either too, but ignores the month for a weekday, so these
// times are always a subset of launchd's and never expect a run it skipped.
const firesOn = (entry: CalendarEntry, date: Temporal.PlainDate) => {
  if (entry.month !== undefined && entry.month !== date.month) {
    return false;
  }
  const onDay = entry.day === undefined || entry.day === date.day;
  // Temporal numbers Monday 1 to Sunday 7; the schedule has Sunday as 0 or 7.
  const onWeekday = entry.weekday === undefined || entry.weekday % 7 === date.dayOfWeek % 7;
  if (entry.day !== undefined && entry.weekday !== undefined) {
    return onDay || onWeekday;
  }
  return onDay && onWeekday;
};

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const HOURS = range(0, 23);
const MINUTES = range(0, 59);

// The minutes of the day, counted from midnight, at which `entry` fires on a
// day it fires on.
const minutesOfDay = (entry: CalendarEntry) =>
  (entry.hour === undefined ? HOURS : [entry.hour]).flatMap((hour) =>
    (entry.minute === undefined ? MINUTES : [entry.minute]).map((minute) => hour * 60 + minute),
  );

// A wall-clock minute of `date` in `timeZone`, as Temporal's `compatible`
// resolves it: a minute a clock change skips falls as much later as the clock
// skips, and one it repeats falls the first time.
const zonedAt = (date: Temporal.PlainDate, minuteOfDay: number, timeZone: string) =>
  date
    .toPlainDateTime({ hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 })
    .toZonedDateTime(timeZone, { disambiguation: 'compatible' });

// The instant (epoch milliseconds) at which a wall-clock minute of `date` falls.
const instantOf = (date: Temporal.PlainDate, minuteOfDay: number, timeZone: string) =>
  zonedAt(date, minuteOfDay, timeZone).epochMilliseconds;

// Whether the clock reads a minute other than `minuteOfDay` when it falls,
// because a clock change skips it.
const isSkipped = (zoned: Temporal.ZonedDateTime, minuteOfDay: number) =>
  zoned.hour * 60 + zoned.minute !== minuteOfDay;

// The latest of `date`'s scheduled times at or before `atOrBefore`, as an
// instant, or undefined when it has none.
const latestOnDay = (
  schedule: readonly CalendarEntry[],
  date: Temporal.PlainDate,
  timeZone: string,
  atOrBefore: number,
) => {
  let latest: number | undefined;
  for (const minute of new Set(schedule.filter((e) => firesOn(e, date)).flatMap(minutesOfDay))) {
    const instant = instantOf(date, minute, timeZone);
    if (instant <= atOrBefore && (latest === undefined || instant > latest)) {
      latest = instant;
    }
  }
  return latest;
};

// The latest time `schedule` names at or before `atOrBefore` and no earlier
// than `notBefore` (epoch milliseconds), reading its entries as wall-clock
// times in `timeZone`, or undefined when there is none. Throws a RangeError for
// a zone this runtime does not know.
//
// Times are compared as instants, since a clock change can resolve a minute
// earlier on the clock to a later instant, even one on the day before: Nuuk
// skips from 23:00 to midnight. No clock skips more than a day, so every time
// of a day falls before every time two days later. The search therefore goes
// back to the first day with a time, or the first that starts at or before
// `notBefore`, and then one day more. It starts a day after the date the
// clock reads at `atOrBefore`, since a clock falling back across midnight
// reads the earlier date after the later date's first minutes have passed.
export const latestScheduledTime = ({
  atOrBefore,
  notBefore,
  schedule,
  timeZone,
}: {
  atOrBefore: number;
  notBefore: number;
  schedule: readonly CalendarEntry[];
  timeZone: string;
}): number | undefined => {
  let date = Temporal.Instant.fromEpochMilliseconds(atOrBefore)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .add({ days: 1 });
  let latest: number | undefined;
  let lastDay: number | undefined;
  for (
    let days = 0;
    days <= MAX_DAYS_SEARCHED && (lastDay === undefined || days <= lastDay);
    days += 1
  ) {
    const onDay = latestOnDay(schedule, date, timeZone, atOrBefore);
    if (onDay !== undefined && (latest === undefined || onDay > latest)) {
      latest = onDay;
    }
    if (
      lastDay === undefined &&
      (onDay !== undefined || instantOf(date, 0, timeZone) <= notBefore)
    ) {
      lastDay = days + 1;
    }
    date = date.subtract({ days: 1 });
  }
  return latest !== undefined && latest >= notBefore ? latest : undefined;
};

// The first time `schedule` names after `after` (epoch milliseconds), reading
// its entries as wall-clock times in `timeZone`; undefined when it names none,
// or the zone is unknown. The search starts a day early, since a clock change
// can put a minute of the day before after `after`. It skips that day when no
// clock change falls in the two days up to `after`: with one offset all that
// time, every minute of the day before falls before `after`.
//
// Within a day the minutes are tried in order and the scan stops at the first
// instant after `after`, because later minutes fall no earlier, unless that
// minute is one a clock change skips: it falls as much later as the clock
// skips, so a later minute can still come first.
export const nextScheduledTime = ({
  after,
  schedule,
  timeZone,
}: {
  after: number;
  schedule: readonly CalendarEntry[];
  timeZone: string;
}): number | undefined => {
  let date: Temporal.PlainDate;
  try {
    date = Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(timeZone).toPlainDate();
  } catch {
    return undefined;
  }
  const change = Temporal.Instant.fromEpochMilliseconds(after - 2 * DAY_MS)
    .toZonedDateTimeISO(timeZone)
    .getTimeZoneTransition('next');
  if (change !== null && change.epochMilliseconds <= after) {
    date = date.subtract({ days: 1 });
  }
  let found: number | undefined;
  for (let days = 0; days <= MAX_DAYS_SEARCHED; days += 1) {
    const minutes = [...new Set(schedule.filter((e) => firesOn(e, date)).flatMap(minutesOfDay))];
    for (const minute of minutes.toSorted((a, b) => a - b)) {
      const zoned = zonedAt(date, minute, timeZone);
      const instant = zoned.epochMilliseconds;
      if (instant > after) {
        if (found === undefined || instant < found) {
          found = instant;
        }
        if (!isSkipped(zoned, minute)) {
          break;
        }
      }
    }
    // No clock skips more than a day, so a time found two days back is the first.
    if (found !== undefined && instantOf(date, 0, timeZone) > found) {
      return found;
    }
    date = date.add({ days: 1 });
  }
  return found;
};
