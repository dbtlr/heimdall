import { harnessColor, stretchTitle } from '../lib/lane.ts';
import { spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Link, Stretch } from '../server/fleet-overview-types.ts';

// How a bar shows whether the Session's process was found: solid when linked,
// a translucent fill with a dashed edge when ambiguous, an outline when not.
const LINK_STYLE: Record<Link, string> = {
  ambiguous:
    'border-[1.5px] border-dashed border-current bg-[color-mix(in_srgb,currentColor_30%,transparent)]',
  linked: 'bg-current',
  unmatched: 'border border-current',
};

// One bar per stretch of an agent Session, colored by Harness, on the lane's
// time axis.
export function SessionStrip({
  stretches,
  timeZone,
  window,
}: {
  stretches: readonly Stretch[];
  timeZone: string;
  window: Window;
}) {
  return (
    <div className="relative mt-1 h-2.5 overflow-hidden">
      {stretches.map((stretch) => {
        const { left, width } = spanBox({ end: stretch.endedAt, start: stretch.startedAt }, window);
        return (
          <div
            className={cn(
              'absolute inset-y-px min-w-[3px] rounded-[2px]',
              LINK_STYLE[stretch.link],
            )}
            key={`${stretch.sessionId}-${String(stretch.startedAt)}`}
            style={{
              color: harnessColor(stretch.harness),
              left: `${String(left)}%`,
              width: `${String(width)}%`,
            }}
            title={stretchTitle(stretch, timeZone)}
          />
        );
      })}
    </div>
  );
}
