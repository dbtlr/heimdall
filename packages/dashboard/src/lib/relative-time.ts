const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// How long before `now` a time was (both epoch milliseconds), as "12 s ago",
// "5 min ago", "3 h ago", or, from 48 hours, "2 d ago". A time ahead of `now`
// (clock skew) reads as 0 s.
export const relativeTime = (at: number, now: number): string => {
  const age = Math.max(0, now - at);
  if (age < MINUTE) {
    return `${String(Math.floor(age / SECOND))} s ago`;
  }
  if (age < HOUR) {
    return `${String(Math.floor(age / MINUTE))} min ago`;
  }
  if (age < 2 * DAY) {
    return `${String(Math.floor(age / HOUR))} h ago`;
  }
  return `${String(Math.floor(age / DAY))} d ago`;
};
