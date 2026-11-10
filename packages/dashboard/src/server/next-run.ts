// When a job that has never run is next due, for Home's Jobs card. firesOn,
// minutesOfDay, and instantOf read a schedule as packages/hub/src/schedule.ts
// does and must change with it; the Hub searches back for the latest time,
// this searches forward for the next.
import type { ScheduleEntry } from './system-detail-types.ts';

// How far ahead the search looks: a little over four years, so an entry for
// 29 February still finds the next leap day.
const MAX_DAYS_AHEAD = 1500;

// Whether `entry` fires on `date`, as the Hub reads a job's schedule: an entry
// that names both a day of the month and a weekday fires on either, and the
// month always applies.
const firesOn = (entry: ScheduleEntry, date: Temporal.PlainDate) => {
  if (entry.month !== undefined && entry.month !== date.month) {
    return false;
  }
  const onDay = entry.day === undefined || entry.day === date.day;
  // Temporal numbers Monday 1 to Sunday 7; the schedule has Sunday as 0 or 7.
  const onWeekday = entry.weekday === undefined || entry.weekday % 7 === date.dayOfWeek % 7;
  return entry.day !== undefined && entry.weekday !== undefined
    ? onDay || onWeekday
    : onDay && onWeekday;
};

// The wall-clock times `entry` fires at on a day it fires on, as minutes of the day.
const minutesOfDay = (entry: ScheduleEntry): number[] => {
  const hours = entry.hour === undefined ? Array.from({ length: 24 }, (_, h) => h) : [entry.hour];
  const minutes =
    entry.minute === undefined ? Array.from({ length: 60 }, (_, m) => m) : [entry.minute];
  return hours.flatMap((hour) => minutes.map((minute) => hour * 60 + minute));
};

// The instant of a wall-clock minute of `date` in `timeZone`, as Temporal's
// `compatible` resolves a minute a clock change skips or repeats.
const instantOf = (date: Temporal.PlainDate, minute: number, timeZone: string) =>
  date
    .toPlainDateTime({ hour: Math.floor(minute / 60), minute: minute % 60 })
    .toZonedDateTime(timeZone, { disambiguation: 'compatible' }).epochMilliseconds;

// The first time `schedule` names after `after` (epoch milliseconds), reading
// its entries as wall-clock times in `timeZone`; undefined when it names none,
// or the zone is unknown. The search starts a day early, since a clock change
// can put a minute of the day before after `after`.
export const nextScheduledTime = ({
  after,
  schedule,
  timeZone,
}: {
  after: number;
  schedule: readonly ScheduleEntry[];
  timeZone: string;
}): number | undefined => {
  let date: Temporal.PlainDate;
  try {
    date = Temporal.Instant.fromEpochMilliseconds(after)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate()
      .subtract({ days: 1 });
  } catch {
    return undefined;
  }
  let found: number | undefined;
  for (let days = 0; days <= MAX_DAYS_AHEAD; days += 1) {
    for (const minute of new Set(schedule.filter((e) => firesOn(e, date)).flatMap(minutesOfDay))) {
      const instant = instantOf(date, minute, timeZone);
      if (instant > after && (found === undefined || instant < found)) {
        found = instant;
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
