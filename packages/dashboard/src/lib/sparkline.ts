import type { Gap } from '../server/fleet-overview-types.ts';

export type SparkPoint = { t: number; value: number };

type SparkBox = {
  // The value drawn at the top; defaults to the largest value, at least 1.
  ceiling?: number;
  // The time window the x axis spans; defaults to the first to the last point.
  from?: number;
  height: number;
  to?: number;
  width: number;
};

type Spot = [x: number, y: number];

const PAD = 1;

const num = (value: number): string => String(Math.round(value * 100) / 100);

const at = ([x, y]: Spot): string => `${num(x)},${num(y)}`;

// The points placed in the box over the window from `from` to `to` (the
// points' own span when not given), values from 0 to the ceiling bottom to
// top, in the runs a gap between two points breaks them into.
const segments = (
  points: readonly SparkPoint[],
  gaps: readonly Gap[],
  { ceiling, from, height, to, width }: SparkBox,
): Spot[][] => {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  const top = ceiling ?? Math.max(1, ...points.map(({ value }) => value));
  const start = from ?? first.t;
  const span = (to ?? last.t) - start;
  const x = (t: number) => (span <= 0 ? width / 2 : ((t - start) / span) * width);
  const y = (value: number) =>
    height - PAD - (Math.min(Math.max(value, 0), top) / top) * (height - 2 * PAD);
  const runs: Spot[][] = [];
  let previous: SparkPoint | undefined;
  for (const point of points) {
    const before = previous;
    const broken =
      before === undefined || gaps.some((gap) => gap.from < point.t && gap.to > before.t);
    if (broken) {
      runs.push([]);
    }
    runs.at(-1)?.push([x(point.t), y(point.value)]);
    previous = point;
  }
  return runs;
};

// An SVG path of the points, so a series that stops early leaves the right end
// empty. A gap between two points breaks the line into segments. Empty for no
// points.
export const sparklinePath = (
  points: readonly SparkPoint[],
  gaps: readonly Gap[],
  box: SparkBox,
): string =>
  segments(points, gaps, box)
    .map((run) => {
      const [head = '', ...rest] = run.map(at);
      // A segment of one point has no length; repeat it so the line cap draws a dot.
      const tail = rest.length === 0 ? [head] : rest;
      return [`M${head}`, ...tail.map((spot) => `L${spot}`)].join(' ');
    })
    .join(' ');

// The area under the sparkline, each segment closed down to the bottom of the
// box, for the gradient fill under the line. Empty for no points.
export const sparklineAreaPath = (
  points: readonly SparkPoint[],
  gaps: readonly Gap[],
  box: SparkBox,
): string =>
  segments(points, gaps, box)
    .map((run) => {
      const bottom = num(box.height);
      const left = num(run[0]?.[0] ?? 0);
      const right = num(run.at(-1)?.[0] ?? 0);
      return [
        `M${left},${bottom}`,
        ...run.map((spot) => `L${at(spot)}`),
        `L${right},${bottom} Z`,
      ].join(' ');
    })
    .join(' ');
