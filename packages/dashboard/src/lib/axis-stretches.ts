// How the shared Activity axis draws a System's Sessions: few enough bars that
// a busy month costs what the lane's width can show, not one per stretch.

import type { AxisStretch } from '../server/activity-types.ts';

// The axis tells stretches apart down to this fraction of its window, about 2
// pixels of a lane at full width.
const STRETCH_RESOLUTION = 720;

// The gap below which two stretches of one Harness on a lane draw as one bar,
// over a window of `windowMs`.
export const stretchGapMs = (windowMs: number): number => windowMs / STRETCH_RESOLUTION;

// `stretches`, in order of start, with those of one Harness that overlap or
// lie within `gapMs` of each other joined into one, so a lane holds at most
// about STRETCH_RESOLUTION bars a Harness however many Sessions ran. The
// result is in order of start.
export const joinStretches = (stretches: readonly AxisStretch[], gapMs: number): AxisStretch[] => {
  const joined: AxisStretch[] = [];
  const open = new Map<string, AxisStretch>();
  for (const stretch of stretches) {
    const last = open.get(stretch.harness);
    if (last !== undefined && stretch.startedAt - last.endedAt <= gapMs) {
      last.endedAt = Math.max(last.endedAt, stretch.endedAt);
    } else {
      const next = { ...stretch };
      joined.push(next);
      open.set(stretch.harness, next);
    }
  }
  return joined;
};
