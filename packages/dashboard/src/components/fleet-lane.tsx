import { gapLabel, nowLine, statusWord } from '../lib/lane.ts';
import { spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Lane, LaneStatus } from '../server/fleet-overview-types.ts';
import { ConditionMarks } from './condition-marks.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { SessionStrip } from './session-strip.tsx';

const STATUS_COLOR: Record<LaneStatus, string> = {
  asleep: 'text-muted-foreground',
  needs_you: 'text-[color-mix(in_srgb,var(--status-serious)_70%,white)]',
  never_seen: 'text-muted-foreground',
  up: 'text-[color-mix(in_srgb,var(--status-good)_60%,white)]',
};

// A grid that gives the label column a fixed width beside the track, and
// stacks them on a phone.
export const LANE_GRID = 'grid gap-1.5 sm:grid-cols-[176px_1fr] sm:gap-4';

// One System on the shared time axis: its name and status beside its CPU plot,
// with the agent Sessions and Conditions of the window under it.
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
    <section aria-label={lane.name} className={cn(LANE_GRID, 'border-t py-2.5')}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 sm:block">
        <p className="text-base font-semibold">{lane.name}</p>
        <p className={cn('text-[13px]', STATUS_COLOR[lane.status])}>{statusWord(lane.status)}</p>
        <p className="text-[12.5px] text-muted-foreground">{nowLine(lane, { now, timeZone })}</p>
      </div>
      <div className="relative min-w-0">
        {lane.gaps.map((gap) => {
          const { left, width } = spanBox({ end: gap.to, start: gap.from }, window);
          const label = gapLabel(gap, { sleeps: lane.sleeps, window });
          return (
            <div
              className="absolute inset-y-0 bg-white/[0.035]"
              key={gap.from}
              style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
            >
              {label !== undefined && (
                <p className="flex h-[46px] items-center justify-center text-[11.5px] text-muted-foreground">
                  {label}
                </p>
              )}
            </div>
          );
        })}
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
    </section>
  );
}
