import type { JobRecord } from '@heimdall/schema';

type CalendarEntry = JobRecord['schedule'][number];

// How far back the search looks before it gives up: a little over four years,
// so an entry for 29 February still finds its last leap day.
const MAX_DAYS_BACK = 1500;

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

// The instant (epoch milliseconds) at which a wall-clock minute of `date`
// falls in `timeZone`, as Temporal's `compatible` resolves it: a minute a
// clock change skips falls as much later as the clock skips, and one it
// repeats falls the first time.
const instantOf = (date: Temporal.PlainDate, minuteOfDay: number, timeZone: string) =>
  date
    .toPlainDateTime({ hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 })
    .toZonedDateTime(timeZone, { disambiguation: 'compatible' }).epochMilliseconds;

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
// `notBefore`, and then one day more.
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
    .toPlainDate();
  let latest: number | undefined;
  let lastDay: number | undefined;
  for (
    let days = 0;
    days <= MAX_DAYS_BACK && (lastDay === undefined || days <= lastDay);
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
