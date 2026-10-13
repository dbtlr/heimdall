import { Link } from '@tanstack/react-router';

import { nowLine, statusWord } from '../lib/lane.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Lane, LaneStatus } from '../server/fleet-overview-types.ts';
import { ConditionMarks } from './condition-marks.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { GapShades } from './gap-shades.tsx';
import { SessionStrip } from './session-strip.tsx';

export const STATUS_COLOR: Record<LaneStatus, string> = {
  asleep: 'text-muted-foreground',
  needs_you: 'text-[color-mix(in_srgb,var(--status-serious)_70%,white)]',
  never_seen: 'text-muted-foreground',
  up: 'text-[color-mix(in_srgb,var(--status-good)_60%,white)]',
};

// A grid that gives the label column a fixed width beside the track, and
// stacks them on a phone.
export const LANE_GRID = 'grid gap-1.5 sm:grid-cols-[176px_1fr] sm:gap-4';

// One System on the shared time axis: its name and status beside its CPU plot,
// with the agent Sessions and Conditions of the window under it. The lane
// opens the System's detail page.
export function FleetLane({
  lane,
  now,
  timeZone,
  window,
}: {
  lane: Lane;
  now: number;
  timeZone: string;
  window: Window;
}) {
  return (
    <Link
      aria-label={lane.name}
      className={cn(LANE_GRID, 'group border-t py-2.5')}
      params={{ name: lane.name }}
      to="/systems/$name"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 sm:block">
        <p className="text-base font-semibold">{lane.name}</p>
        <p className={cn('text-[13px]', STATUS_COLOR[lane.status])}>{statusWord(lane.status)}</p>
        <p className="text-[12.5px] text-muted-foreground">{nowLine(lane, { now, timeZone })}</p>
      </div>
      <div className="relative min-w-0 group-hover:bg-white/[0.025]">
        <GapShades gaps={lane.gaps} labelHeight={46} sleeps={lane.sleeps} window={window} />
        <CpuPlot
          buckets={lane.buckets}
          label={`${lane.name} CPU busy`}
          timeZone={timeZone}
          window={window}
        />
        <SessionStrip stretches={lane.stretches} timeZone={timeZone} window={window} />
        <ConditionMarks
          conditions={lane.conditions}
          now={now}
          timeZone={timeZone}
          window={window}
        />
      </div>
    </Link>
  );
}
