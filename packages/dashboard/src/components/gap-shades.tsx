import { gapLabel } from '../lib/lane.ts';
import { spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import type { Gap } from '../server/fleet-overview-types.ts';

// The runs of 5-minute buckets with no Vitals, shaded across a track and
// labeled "asleep" or "no Reports" where they are wide enough, with the label
// centered in the top `labelHeight` pixels.
export function GapShades({
  gaps,
  labelHeight,
  sleeps,
  window,
}: {
  gaps: readonly Gap[];
  labelHeight: number;
  sleeps: boolean;
  window: Window;
}) {
  return gaps.map((gap) => {
    const { left, width } = spanBox({ end: gap.to, start: gap.from }, window);
    const label = gapLabel(gap, { sleeps, window });
    return (
      <div
        className="absolute inset-y-0 bg-white/[0.035]"
        key={gap.from}
        style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
      >
        {label !== undefined && (
          <p
            className="flex items-center justify-center text-[11.5px] text-muted-foreground"
            style={{ height: labelHeight }}
          >
            {label}
          </p>
        )}
      </div>
    );
  });
}
