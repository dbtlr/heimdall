// How fast a mount fills, from the readings the chart shows.

export type DiskReading = { t: number; totalBytes: number; usedBytes: number };

export type DiskGrowth = {
  bytesPerDay: number;
  // Days until the mount is full at that rate, measured from the newest
  // reading; undefined when it is not growing.
  daysUntilFull: number | undefined;
};

const DAY_MS = 86_400_000;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

// Fewer hours of readings than this are too few to call a trend.
const MIN_SPAN_MS = DAY_MS;

// A least-squares line through used bytes over time, or undefined when there
// are fewer than two readings or they span less than a day.
export const diskGrowth = (readings: readonly DiskReading[]): DiskGrowth | undefined => {
  const newest = readings.at(-1);
  const oldest = readings[0];
  if (newest === undefined || oldest === undefined || newest.t - oldest.t < MIN_SPAN_MS) {
    return undefined;
  }
  const count = readings.length;
  // Times counted in days from the first reading keep the sums small.
  const days = readings.map((reading) => (reading.t - oldest.t) / DAY_MS);
  const meanDay = days.reduce((sum, day) => sum + day, 0) / count;
  const meanUsed = readings.reduce((sum, reading) => sum + reading.usedBytes, 0) / count;
  let covariance = 0;
  let variance = 0;
  for (const [index, reading] of readings.entries()) {
    const dayOffset = (days[index] ?? 0) - meanDay;
    covariance += dayOffset * (reading.usedBytes - meanUsed);
    variance += dayOffset * dayOffset;
  }
  if (variance === 0) {
    return undefined;
  }
  const bytesPerDay = covariance / variance;
  const free = Math.max(0, newest.totalBytes - newest.usedBytes);
  return {
    bytesPerDay,
    daysUntilFull: bytesPerDay > 0 ? free / bytesPerDay : undefined,
  };
};

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
