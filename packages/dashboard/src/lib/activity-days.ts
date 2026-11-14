import { formatDayHeading, localDayNumber } from './time.ts';

export type DayGroup<T> = { entries: T[]; heading: string; key: number };

// "Today", "Yesterday", else the weekday and date, of the local day of `at`
// counted against the day of `now`.
const dayHeading = (at: number, now: number, timeZone: string): string => {
  const ago = localDayNumber(now, timeZone) - localDayNumber(at, timeZone);
  if (ago === 0) {
    return 'Today';
  }
  return ago === 1 ? 'Yesterday' : formatDayHeading(at, timeZone);
};

// Entries grouped under the local day (in `timeZone`) of their `at`, in the
// order given: a new group opens whenever the day differs from the entry before.
export const groupByDay = <T extends { at: number }>(
  entries: readonly T[],
  now: number,
  timeZone: string,
): DayGroup<T>[] => {
  const groups: DayGroup<T>[] = [];
  for (const entry of entries) {
    const key = localDayNumber(entry.at, timeZone);
    const last = groups.at(-1);
    if (last?.key === key) {
      last.entries.push(entry);
    } else {
      groups.push({ entries: [entry], heading: dayHeading(entry.at, now, timeZone), key });
    }
  }
  return groups;
};
