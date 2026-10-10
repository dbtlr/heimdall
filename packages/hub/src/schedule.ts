import type { JobRecord } from '@heimdall/schema';

type CalendarEntry = JobRecord['schedule'][number];

const MINUTES_PER_DAY = 1440;

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

// The latest minute of the day, counted from midnight, at which `entry` fires
// that is no later than `limit`, or undefined when there is none.
const latestMinuteOfDay = (entry: CalendarEntry, limit: number): number | undefined => {
  const limitHour = Math.floor(limit / 60);
  const limitMinute = limit % 60;
  if (entry.hour !== undefined) {
    if (entry.hour > limitHour) {
      return undefined;
    }
    const lastMinute = entry.hour === limitHour ? limitMinute : 59;
    if (entry.minute === undefined) {
      return entry.hour * 60 + lastMinute;
    }
    return entry.minute <= lastMinute ? entry.hour * 60 + entry.minute : undefined;
  }
  if (entry.minute === undefined) {
    return limit;
  }
  if (entry.minute <= limitMinute) {
    return limitHour * 60 + entry.minute;
  }
  return limitHour > 0 ? (limitHour - 1) * 60 + entry.minute : undefined;
};

// The instant (epoch milliseconds) at which a wall-clock minute of `date`
// falls in `timeZone`. A minute a clock change skips falls an hour later, and
// one it repeats falls the first time, as Temporal's `compatible` resolves them.
const instantOf = (date: Temporal.PlainDate, minuteOfDay: number, timeZone: string) =>
  date
    .toPlainDateTime({ hour: Math.floor(minuteOfDay / 60), minute: minuteOfDay % 60 })
    .toZonedDateTime(timeZone, { disambiguation: 'compatible' }).epochMilliseconds;

// The latest time `schedule` names at or before `atOrBefore` and no earlier
// than `notBefore` (epoch milliseconds), reading its entries as wall-clock
// times in `timeZone`, or undefined when there is none. Throws a RangeError for
// a zone this runtime does not know.
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
  const start = Temporal.Instant.fromEpochMilliseconds(atOrBefore).toZonedDateTimeISO(timeZone);
  let date = start.toPlainDate();
  let limit = start.hour * 60 + start.minute;
  for (let days = 0; days <= MAX_DAYS_BACK;) {
    let latest: number | undefined;
    for (const entry of schedule) {
      const minute = firesOn(entry, date) ? latestMinuteOfDay(entry, limit) : undefined;
      if (minute !== undefined && (latest === undefined || minute > latest)) {
        latest = minute;
      }
    }
    if (latest !== undefined) {
      const instant = instantOf(date, latest, timeZone);
      // A skipped minute falls an hour later, possibly after `atOrBefore`; the
      // search then goes on from the minute before it.
      if (instant <= atOrBefore) {
        return instant >= notBefore ? instant : undefined;
      }
      limit = latest - 1;
      if (limit >= 0) {
        continue;
      }
    }
    date = date.subtract({ days: 1 });
    limit = MINUTES_PER_DAY - 1;
    days += 1;
    // Every minute of an earlier day falls before `notBefore`.
    if (instantOf(date, limit, timeZone) < notBefore) {
      return undefined;
    }
  }
  return undefined;
};
