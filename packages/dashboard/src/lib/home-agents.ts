// What Home says about agent work: the local days its cost is counted over,
// what is usually spent by this time of day, and which Sessions are running.

import type { SessionKey } from '../server/session-view-types.ts';

// A Session is running while its latest request is no older than this.
export const RUNNING_MS = 5 * 60_000;

// How many running Sessions Home's Agents card lists before "+N more".
export const RUNNING_SHOWN = 5;

// One local day in epoch milliseconds: from its first instant to the next
// day's, and `cutoff`, the instant that day reached the time of day it is now.
export type LocalDay = { cutoff: number; end: number; start: number };

// The `count` local days in `timeZone` that end with today, oldest first.
// A day starts at its first instant, as the Agents page's Today does, so a
// skipped midnight starts it at the hour after and a clock change gives it 23
// or 25 hours. Today's cutoff is `now`; an earlier day's is the same wall-clock
// time on it, kept inside the day when that time did not exist on it.
export const localDays = (now: number, timeZone: string, count: number): LocalDay[] => {
  const here = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone);
  const date = here.toPlainDate();
  const time = here.toPlainTime();
  const startOf = (day: Temporal.PlainDate) =>
    day.toZonedDateTime({ timeZone }).startOfDay().epochMilliseconds;
  return Array.from({ length: count }, (_, index) => {
    const ago = count - 1 - index;
    const day = date.subtract({ days: ago });
    const start = startOf(day);
    const end = startOf(day.add({ days: 1 }));
    const cutoff =
      ago === 0 ? now : day.toZonedDateTime({ plainTime: time, timeZone }).epochMilliseconds;
    return { cutoff: Math.min(end, Math.max(start, cutoff)), end, start };
  });
};

// What is usually spent by now: the median, over the earlier days that had
// any request, of what each had spent by its cutoff. A day with no request is
// left out, so days off do not pull it to nothing. Undefined with fewer than
// 3 such days, too few to call usual.
export const usualByNow = (
  days: readonly { byNowUsd: number; requests: number }[],
): number | undefined => {
  const spent = days
    .filter(({ requests }) => requests > 0)
    .map(({ byNowUsd }) => byNowUsd)
    .toSorted((a, b) => a - b);
  if (spent.length < 3) {
    return undefined;
  }
  const middle = Math.floor(spent.length / 2);
  return spent.length % 2 === 1
    ? (spent[middle] ?? 0)
    : ((spent[middle - 1] ?? 0) + (spent[middle] ?? 0)) / 2;
};

export const isRunning = (lastRequestAt: number, now: number): boolean =>
  now - lastRequestAt <= RUNNING_MS;

// What a "running" label says it means, wherever the dashboard shows one.
export const RUNNING_TITLE = 'A request was observed in the last 5 minutes';

type Running = SessionKey & { lastRequestAt: number };

const keyOf = ({ harness, sessionId, source, system }: SessionKey) =>
  JSON.stringify([system, harness, source, sessionId]);

// The running Sessions Home lists, the latest request first, and how many more
// there are past `cap`.
export const shownRunning = <S extends Running>(
  running: readonly S[],
  cap = RUNNING_SHOWN,
): { more: number; shown: S[] } => {
  const ordered = running.toSorted(
    (a, b) => b.lastRequestAt - a.lastRequestAt || keyOf(a).localeCompare(keyOf(b)),
  );
  return { more: Math.max(0, ordered.length - cap), shown: ordered.slice(0, cap) };
};

// A System tile's running chip: how many Sessions run on `system`, and their
// Harness when every one shares it. Undefined when none runs there.
export const runningChip = (
  running: readonly SessionKey[],
  system: string,
): { count: number; harness: string | undefined } | undefined => {
  const here = running.filter((session) => session.system === system);
  const [first] = here;
  if (first === undefined) {
    return undefined;
  }
  return {
    count: here.length,
    harness: here.every(({ harness }) => harness === first.harness) ? first.harness : undefined,
  };
};

// A dollar amount rounded to whole dollars, as the verdict shows it: "$148".
export const wholeDollars = (usd: number): string => `$${Math.round(usd).toLocaleString('en-US')}`;
