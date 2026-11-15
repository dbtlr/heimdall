// Shared disk reading types and forecast words.

export type DiskReading = { t: number; totalBytes: number; usedBytes: number };

export type DiskGrowth = { bytesPerDay: number };

const DAY_MS = 86_400_000;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

// Growth slower than a MiB a day is a mount's churn bending the fitted line,
// not a trend: it gets no rate and no forecast.
export const isGrowing = ({ bytesPerDay }: Pick<DiskGrowth, 'bytesPerDay'>): boolean =>
  bytesPerDay >= MIB;

// "38 GiB", or "3.2 GiB" below ten.
export const gibWords = (bytes: number): string => {
  const value = bytes / GIB;
  return `${value >= 10 ? String(Math.round(value)) : value.toFixed(1)} GiB`;
};

// "+2.1 GiB a day", or "+300 MiB a day" below a GiB.
export const growthWords = (bytesPerDay: number): string =>
  `+${bytesPerDay >= GIB ? gibWords(bytesPerDay) : `${String(Math.round(bytesPerDay / MIB))} MiB`} a day`;

// When a growing mount reaches a mark it is `days` from: "now" once there,
// "in under a day", "in about 18 days", or "in over a year".
export const reachWords = (days: number): string => {
  if (days <= 0) {
    return 'now';
  }
  if (days < 1) {
    return 'in under a day';
  }
  if (days >= 365) {
    return 'in over a year';
  }
  const whole = Math.round(days);
  return `in about ${String(whole)} ${whole === 1 ? 'day' : 'days'}`;
};

// The fitted span, in the same units as the Condition chart's window.
export const spanWords = (span: number): string =>
  span >= 2 * DAY_MS
    ? `${String(Math.round(span / DAY_MS))} days`
    : `${String(Math.round(span / 3_600_000))} h`;
