import type { ChecksSection } from '@heimdall/schema';

// The parts of a checks section as the loops build them, before the reporter
// weighs each against its budget.
export type CheckParts = Omit<ChecksSection, 'overBudget'>;

// Where a loop's latest parts are read from: the parts it built last, or
// undefined while it has not finished a tick.
export type CheckPartsSource = { latest: () => CheckParts | undefined };

// The parts of every source joined into one, or undefined while none has any.
// The same object is answered until a source's parts change, so the reporter can
// tell by identity that nothing did. A part two sources both carry takes the
// later source's.
export const combineParts = (sources: readonly CheckPartsSource[]): CheckPartsSource => {
  let seen: (CheckParts | undefined)[] = [];
  let combined: CheckParts | undefined;
  return {
    latest: () => {
      const now = sources.map((source) => source.latest());
      if (now.length !== seen.length || now.some((parts, i) => parts !== seen[i])) {
        seen = now;
        const present = now.filter((parts) => parts !== undefined);
        combined = present.length === 0 ? undefined : Object.assign({}, ...present);
      }
      return combined;
    },
  };
};
