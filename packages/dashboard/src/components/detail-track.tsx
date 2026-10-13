import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

import { inWindow, xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { LANE_GRID } from './fleet-lane.tsx';

type Axis = {
  hovered: number | undefined;
  hover: (t: number | undefined) => void;
  select: (t: number) => void;
  selected: number | undefined;
  window: Window;
};

const AxisContext = createContext<Axis | undefined>(undefined);

const useAxis = (): Axis => {
  const axis = useContext(AxisContext);
  if (axis === undefined) {
    throw new Error('A detail track must sit inside a DetailAxis.');
  }
  return axis;
};

// The shared time axis of the System detail stack: every track under it shows
// the time the pointer is over, and selecting a time on any of them selects
// it for the inspector.
export function DetailAxis({
  children,
  onSelect,
  selected,
  window,
}: {
  children: ReactNode;
  onSelect: (t: number) => void;
  selected: number | undefined;
  window: Window;
}) {
  const [hovered, hover] = useState<number | undefined>();
  return (
    <AxisContext.Provider value={{ hover, hovered, select: onSelect, selected, window }}>
      {children}
    </AxisContext.Provider>
  );
}

// A vertical mark across a track at `t`.
function Mark({ className, t, window }: { className: string; t: number; window: Window }) {
  return inWindow(t, window) ? (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-y-0', className)}
      style={{ left: `${String(xPercent(t, window))}%` }}
    />
  ) : null;
}

// The time under the pointer in a track.
const timeAt = (event: React.MouseEvent<HTMLElement>, { from, to }: Window) => {
  const box = event.currentTarget.getBoundingClientRect();
  return from + ((event.clientX - box.left) / box.width) * (to - from);
};

// The plot side of a detail row: its children on the axis, with the selected
// sample and the pointer's time marked.
export function DetailTrack({ children, className }: { children: ReactNode; className?: string }) {
  const { hover, hovered, select, selected, window } = useAxis();
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the pointer picks a time; the inspector also opens on the newest sample.
    <div
      className={cn('relative min-w-0 cursor-crosshair', className)}
      onClick={(event) => select(timeAt(event, window))}
      onMouseLeave={() => hover(undefined)}
      onMouseMove={(event) => hover(timeAt(event, window))}
    >
      {children}
      {selected !== undefined && (
        <Mark
          className="w-[5px] -translate-x-1/2 bg-[rgba(255,214,102,0.22)]"
          t={selected}
          window={window}
        />
      )}
      {hovered !== undefined && <Mark className="w-px bg-white/30" t={hovered} window={window} />}
    </div>
  );
}

// One row of the stack: a label beside its track, stacked on a phone.
export function DetailRow({
  children,
  label,
  note,
}: {
  children: ReactNode;
  label: string;
  note?: string | undefined;
}) {
  return (
    <section aria-label={label} className={cn(LANE_GRID, 'border-t py-2.5')}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 sm:block sm:pt-0.5">
        <p className="text-sm font-semibold">{label}</p>
        {note !== undefined && <p className="text-[12.5px] text-muted-foreground">{note}</p>}
      </div>
      <DetailTrack>{children}</DetailTrack>
    </section>
  );
}
