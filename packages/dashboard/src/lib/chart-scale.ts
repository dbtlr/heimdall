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

// The labels a plot's value scale shows: its top, its middle, and its bottom.
export const scaleTicks = (domain: Domain): ScaleTick[] => {
  const [low, high] = domain;
  return [high, (low + high) / 2, low].map((value) => ({ value, y: yPercent(value, domain) }));
};
