// A plot's value scale, from its bottom value to its top value.
export type Domain = readonly [number, number];

// One label of a value scale, `y` percent down the plot from its top.
export type ScaleTick = { value: number; y: number };

// How far down the plot `value` sits, as a percentage of its height from the
// top: the top of the domain at 0, its bottom at 100. A value outside the
// domain stays on the nearer edge.
export const yPercent = (value: number, [low, high]: Domain): number => {
  if (high <= low) {
    return 50;
  }
  const share = (high - value) / (high - low);
  return Math.min(Math.max(share, 0), 1) * 100;
};

// A count of steps, rid of the floating-point error that division leaves.
const steps = (value: number, step: number): number => Number((value / step).toPrecision(12));

// The domain widened out to whole multiples of two steps, so its top, middle,
// and bottom are each a whole step and a label rounded to the step states
// exactly the value drawn at its position.
export const niceDomain = ([low, high]: Domain, step: number): Domain => {
  const span = 2 * step;
  const snap = (count: number) => Number((count * span).toPrecision(12));
  return [snap(Math.floor(steps(low, span))), snap(Math.ceil(steps(high, span)))];
};

// The labels a plot's value scale shows: its top, its middle, and its bottom.
export const scaleTicks = (domain: Domain): ScaleTick[] => {
  const [low, high] = domain;
  return [high, (low + high) / 2, low].map((value) => ({ value, y: yPercent(value, domain) }));
};
