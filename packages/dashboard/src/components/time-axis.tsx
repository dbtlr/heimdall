import { axisTicks } from '../lib/axis.ts';
import { xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Range } from '../server/fleet-overview-types.ts';
import { LANE_GRID } from './fleet-lane.tsx';

const ALIGN = { end: '-translate-x-full', middle: '-translate-x-1/2', start: '' } as const;

// The labels under the lanes, at round local times. A narrow screen drops the
// minor ones.
export function TimeAxis({
  range,
  timeZone,
  window,
}: {
  range: Range;
  timeZone: string;
  window: Window;
}) {
  return (
    <div className={cn(LANE_GRID, 'pt-0.5')}>
      <div className="hidden sm:block" />
      <div className="relative h-4 text-[11.5px] text-muted-foreground">
        {axisTicks(range, window, timeZone).map((tick) => (
          <span
            className={cn('absolute', ALIGN[tick.edge], tick.minor && 'hidden sm:block')}
            key={tick.at}
            style={{ left: `${String(xPercent(tick.at, window))}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}
