// The width of the buckets a span of Vitals is drawn in, so a chart's points,
// and the rows its read returns, follow the number of buckets and not the span.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// The most buckets a span is drawn in unless the caller says otherwise.
const MAX_BUCKETS = 90;

// Each divides a day, so a bucket starts on the same grid from any origin at
// midnight UTC, the Hub's and the page's alike.
const WIDTHS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map(
  (minutes) => minutes * MINUTE_MS,
);

// The smallest of 1, 2, 5, 10, 15, and 30 minutes, 1, 2, 3, 6, 12, and 24
// hours, then whole days, that covers `spanMs` in at most `maxBuckets` buckets.
export const bucketFor = (spanMs: number, maxBuckets = MAX_BUCKETS): number =>
  WIDTHS_MS.find((width) => Math.ceil(spanMs / width) <= maxBuckets) ??
  Math.ceil(spanMs / maxBuckets / DAY_MS) * DAY_MS;
