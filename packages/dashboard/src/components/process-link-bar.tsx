import { harnessColor } from '../lib/lane.ts';
import { formatClock, spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Link } from '../server/fleet-overview-types.ts';
import type { SessionStretch } from '../server/session-view-types.ts';

// As for Session stretches elsewhere: solid when linked, a translucent fill
// with a dashed edge when ambiguous, an outline when unmatched.
const LINK_STYLE: Record<Link, string> = {
  ambiguous:
    'border-[1.5px] border-dashed border-current bg-[color-mix(in_srgb,currentColor_30%,transparent)]',
  linked: 'bg-current',
  unmatched: 'border border-current',
};

// What a stretch's bar says: its process, how many it could have been, or none.
export const linkLabel = (stretch: SessionStretch): string => {
  if (stretch.link === 'linked') {
    return `pid ${String(stretch.pid)}`;
  }
  return stretch.link === 'ambiguous'
    ? `${String(stretch.candidates)} candidates`
    : 'no process seen';
};

// Each stretch of the Session as a bar on the axis, labeled with the process
// the Hub links it to.
export function ProcessLinkBar({
  harness,
  stretches,
  timeZone,
  window,
}: {
  harness: string;
  stretches: readonly SessionStretch[];
  timeZone: string;
  window: Window;
}) {
  return (
    <div className="relative h-4" style={{ color: harnessColor(harness) }}>
      {stretches.map((stretch) => {
        const { left, width } = spanBox({ end: stretch.endedAt, start: stretch.startedAt }, window);
        return (
          <div
            className={cn(
              'absolute inset-y-0 min-w-[3px] overflow-hidden rounded-[2px]',
              LINK_STYLE[stretch.link],
            )}
            key={stretch.startedAt}
            style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
            title={`${formatClock(stretch.startedAt, timeZone)} to ${formatClock(stretch.endedAt, timeZone)}, ${String(stretch.requests)} requests, ${linkLabel(stretch)}`}
          >
            <span
              className={cn(
                'block truncate px-1.5 text-[11px] leading-4',
                stretch.link === 'linked' ? 'text-white' : 'text-foreground',
              )}
            >
              {linkLabel(stretch)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
