import { Link } from '@tanstack/react-router';

import { anchorOf, subjectText } from '../lib/attention.ts';
import { nowLine } from '../lib/lane.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import type { Lane } from '../server/fleet-overview-types.ts';
import { AttentionStatus, AttentionSubject, namedItem } from './attention-status.tsx';
import { ConditionMarks } from './condition-marks.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { PhraseText } from './date-time.tsx';
import { GapShades } from './gap-shades.tsx';
import { SessionStrip } from './session-strip.tsx';

// A grid that gives the label column a fixed width beside the track, and
// stacks them on a phone. A page with longer labels widens the column by
// setting --lane-label on an element around its lanes.
export const LANE_GRID = 'grid gap-1.5 sm:grid-cols-[var(--lane-label,176px)_1fr] sm:gap-4';

// One System on the shared time axis: its name and status beside its CPU plot,
// with the agent Sessions and Conditions of the window under it. The status
// names the cause and its subject. The lane opens the System's detail page, at
// the cause when it names one.
export function FleetLane({
  items,
  lane,
  now,
  window,
}: {
  items: readonly Attention[];
  lane: Lane;
  now: number;
  window: Window;
}) {
  const named = namedItem(items, lane.status);
  return (
    <Link
      aria-label={lane.name}
      className={cn(LANE_GRID, 'group border-t py-2.5')}
      {...(named === undefined ? {} : { hash: anchorOf(named) })}
      params={{ name: lane.name }}
      to="/systems/$name"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 sm:block">
        <p className="text-base font-semibold">{lane.name}</p>
        <p className="text-[13px]">
          <AttentionStatus items={items} status={lane.status} />
        </p>
        {named !== undefined && subjectText(named) !== '' && (
          <p className="w-full text-[12.5px] leading-[1.3] wrap-anywhere text-[#c4cad8]">
            <AttentionSubject item={named} />
          </p>
        )}
        <p className="text-[12.5px] text-muted-foreground">
          <PhraseText phrase={nowLine(lane, now)} />
        </p>
      </div>
      <div className="relative min-w-0 group-hover:bg-white/[0.025]">
        <GapShades gaps={lane.gaps} labelHeight={46} sleeps={lane.sleeps} window={window} />
        <CpuPlot buckets={lane.buckets} label={`${lane.name} CPU busy`} window={window} />
        <SessionStrip stretches={lane.stretches} window={window} />
        <ConditionMarks conditions={lane.conditions} now={now} window={window} />
      </div>
    </Link>
  );
}
