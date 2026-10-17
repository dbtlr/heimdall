// How fast a mount fills, from the readings the chart shows.

export type DiskReading = { t: number; totalBytes: number; usedBytes: number };

export type DiskGrowth = {
  bytesPerDay: number;
  // Days until the mount is full at that rate, measured from the newest
  // reading; undefined when it is not growing.
  daysUntilFull: number | undefined;
};

const DAY_MS = 86_400_000;

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
