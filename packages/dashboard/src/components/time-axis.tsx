import type { ReactNode } from 'react';

import { crowdsAnEndWhenNarrow } from '../lib/axis.ts';
import type { Tick } from '../lib/axis.ts';
import { LANE_GRID } from '../lib/layout.ts';
import { xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';

const ALIGN = { end: '-translate-x-full', middle: '-translate-x-1/2', start: '' } as const;

// The axis's padding above its labels and their line, in pixels. A placeholder
// that holds the axis's room before the zone is known reads its height.
const TIME_AXIS_PADDING = 2;
const TIME_AXIS_LINE = 16;
export const TIME_AXIS_HEIGHT = TIME_AXIS_PADDING + TIME_AXIS_LINE;

// The labels under the lanes at `ticks`, with any `children` over them. A
// narrow screen drops the minor ones and any that would crowd an end's label.
export function TimeAxis({
  bare = false,
  children,
  ticks,
  window,
}: {
  // Without the empty label column of the lanes, for tracks that span their card.
  bare?: boolean;
  children?: ReactNode;
  ticks: readonly Tick[];
  window: Window;
}) {
  return (
    <div
      className={cn(!bare && LANE_GRID)}
      data-time-axis
      style={{ paddingTop: TIME_AXIS_PADDING }}
    >
      {!bare && <div className="hidden sm:block" />}
      <div
        className="relative text-xs text-muted-foreground tabular-nums"
        data-time-axis-ticks
        style={{ height: TIME_AXIS_LINE }}
      >
        {ticks.map((tick) => (
          <span
            className={cn(
              'absolute whitespace-nowrap',
              ALIGN[tick.edge],
              (tick.minor || crowdsAnEndWhenNarrow(tick, window)) && 'hidden sm:block',
            )}
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
