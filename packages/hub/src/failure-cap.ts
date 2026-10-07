// The outcome of starting an attempt under a failure cap: either the attempt
// counts as a failure until it reports success, or the cap is full and the
// next slot frees after `retryAfterMs`.
export type CapSlot =
  | { kind: 'counted'; succeeded: () => void }
  | { kind: 'refused'; retryAfterMs: number };

// A cap of `limit` failures in any `windowMs`, timed by `clock`, a monotonic
// clock in milliseconds such as performance.now. An
// attempt counts as a failure from the moment it starts, so attempts in flight
// at once cannot overrun the cap together; one that succeeds stops counting.
// It keeps at most `limit` times in memory.
export const failureCap = ({
  clock,
  limit,
  windowMs,
}: {
  clock: () => number;
  limit: number;
  windowMs: number;
}) => {
  let failures: { at: number }[] = [];
  return {
    begin: (): CapSlot => {
      const at = clock();
      failures = failures.filter((failure) => failure.at > at - windowMs);
      if (failures.length >= limit) {
        const oldest = Math.min(...failures.map((failure) => failure.at));
        return { kind: 'refused', retryAfterMs: oldest + windowMs - at };
      }
      const failure = { at };
      failures.push(failure);
      return {
        kind: 'counted',
        succeeded: () => {
          failures = failures.filter((each) => each !== failure);
        },
      };
    },
  };
};
