import type { ReactNode } from 'react';

import type { Tick } from '../lib/axis.ts';
import { xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { LANE_GRID } from './fleet-lane.tsx';

const ALIGN = { end: '-translate-x-full', middle: '-translate-x-1/2', start: '' } as const;

// The labels under the lanes at `ticks`, with any `children` over them. A
// narrow screen drops the minor ones.
export function TimeAxis({
  children,
  ticks,
  window,
}: {
  children?: ReactNode;
  ticks: readonly Tick[];
  window: Window;
}) {
  return (
    <div className={cn(LANE_GRID, 'pt-0.5')}>
      <div className="hidden sm:block" />
      <div className="relative h-4 text-[11.5px] text-muted-foreground">
        {ticks.map((tick) => (
          <span
            className={cn('absolute', ALIGN[tick.edge], tick.minor && 'hidden sm:block')}
            key={tick.at}
            style={{ left: `${String(xPercent(tick.at, window))}%` }}
          >
            {tick.label}
          </span>
        ))}
        {children}
      </div>
    </div>
  );
}
