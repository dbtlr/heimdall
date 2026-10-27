import type { Gap } from '../server/fleet-overview-types.ts';

export type SparkPoint = { t: number; value: number };

type SparkBox = {
  // The value drawn at the top; defaults to the largest value, at least 1.
  ceiling?: number;
  height: number;
  width: number;
};

const PAD = 1;

const num = (value: number): string => String(Math.round(value * 100) / 100);

// An SVG path of the points over their time span, values from 0 to the ceiling
// bottom to top. A gap between two points breaks the line into segments. Empty
// for no points.
export const sparklinePath = (
  points: readonly SparkPoint[],
  gaps: readonly Gap[],
  { ceiling, height, width }: SparkBox,
): string => {
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return '';
  }
  const top = ceiling ?? Math.max(1, ...points.map(({ value }) => value));
  const span = last.t - first.t;
  const x = (t: number) => (span === 0 ? width / 2 : ((t - first.t) / span) * width);
  const y = (value: number) =>
    height - PAD - (Math.min(Math.max(value, 0), top) / top) * (height - 2 * PAD);
  const parts: string[] = [];
  let previous: SparkPoint | undefined;
  for (const point of points) {
    const before = previous;
    const broken =
      before === undefined || gaps.some(({ from, to }) => from < point.t && to > before.t);
    parts.push(`${broken ? 'M' : 'L'}${num(x(point.t))},${num(y(point.value))}`);
    previous = point;
  }
  const path = parts.join(' ');
  // A segment of one point has no length; repeat it so the line cap draws a dot.
  return path.replace(/M([\d.]+,[\d.]+)(?= M|$)/gu, 'M$1 L$1');
};
