import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

import { steppedSample } from '../lib/detail.ts';
import { LANE_GRID } from '../lib/layout.ts';
import { formatDated, inWindow, pinnedX, xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { cn } from '../lib/utils.ts';

type Axis = {
  at: number | undefined;
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
// it for the inspector. `selected` is the sample read for the pinned time `at`,
// the stored one nearest it.
export function DetailAxis({
  at,
  children,
  onSelect,
  selected,
  window,
}: {
  at?: number | undefined;
  children: ReactNode;
  onSelect: (t: number) => void;
  selected: number | undefined;
  window: Window;
}) {
  const [hovered, hover] = useState<number | undefined>();
  return (
    <AxisContext.Provider value={{ at, hover, hovered, select: onSelect, selected, window }}>
      {children}
    </AxisContext.Provider>
  );
}

// A vertical mark across a track `x` percent from its left, or none.
function Mark({ className, x }: { className: string; x: number | undefined }) {
  return x === undefined ? null : (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none absolute inset-y-0', className)}
      style={{ left: `${String(x)}%` }}
    />
  );
}

// The time under the pointer in a track.
const timeAt = (event: React.MouseEvent<HTMLElement>, { from, to }: Window) => {
  const box = event.currentTarget.getBoundingClientRect();
  return from + ((event.clientX - box.left) / box.width) * (to - from);
};

// The plot side of a detail row: its children on the axis, with the selected
// sample and the pointer's time marked. `onSelect` replaces the axis's select
// for a row that picks something nearer than a time.
export function DetailTrack({
  children,
  className,
  onSelect,
}: {
  children: ReactNode;
  className?: string;
  onSelect?: ((t: number) => void) | undefined;
}) {
  const { hover, hovered, select, selected, window } = useAxis();
  const selectedX = selected === undefined ? undefined : pinnedX(selected, window);
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the pointer picks a time; the inspector also opens on the newest sample.
    <div
      className={cn('relative min-w-0 cursor-crosshair', className)}
      onClick={(event) => (onSelect ?? select)(timeAt(event, window))}
      onMouseLeave={() => hover(undefined)}
      onMouseMove={(event) => hover(timeAt(event, window))}
    >
      {children}
      <Mark className="w-[5px] -translate-x-1/2 bg-select/25" x={selectedX} />
      <Mark className="w-px -translate-x-1/2 bg-select" x={selectedX} />
      {hovered !== undefined && inWindow(hovered, window) && (
        <Mark className="w-px bg-white/30" x={xPercent(hovered, window)} />
      )}
    </div>
  );
}

// The keyboard's way to pin a sample: `children`, the axis's time labels, as a
// slider over the window. The arrow keys move the pinned time a bucket, an hour
// with Shift or Page Up and Page Down, and Home and End move it to the window's
// ends; with none pinned it stands at the newest time. It steps from the pinned
// time, not the sample nearest it, so presses carry on across a gap in the
// samples, and it never stands outside the window.
export function SampleSlider({ children }: { children: ReactNode }) {
  const { at: pinned, select, selected, window } = useAxis();
  const timeZone = useTimeZone();
  const at = Math.min(window.to, Math.max(window.from, pinned ?? selected ?? window.to));
  return (
    <div
      aria-label="Pinned sample"
      aria-valuemax={window.to}
      aria-valuemin={window.from}
      aria-valuenow={at}
      aria-valuetext={timeZone === undefined ? undefined : formatDated(at, window.to, timeZone)}
      className="rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onKeyDown={(event) => {
        const next = steppedSample(event, at, window);
        if (next !== undefined) {
          event.preventDefault();
          select(next);
        }
      }}
      role="slider"
      tabIndex={0}
    >
      {children}
    </div>
  );
}

// One row of the stack: a label beside its track, stacked on a phone.
export function DetailRow({
  children,
  label,
  note,
  onSelect,
}: {
  children: ReactNode;
  label: string;
  note?: string | undefined;
  onSelect?: ((t: number) => void) | undefined;
}) {
  return (
    <section aria-label={label} className={cn(LANE_GRID, 'border-t py-2.5')}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 sm:block sm:pt-0.5">
        <p className="text-sm font-semibold">{label}</p>
        {note !== undefined && <p className="text-[12.5px] text-muted-foreground">{note}</p>}
      </div>
      <DetailTrack onSelect={onSelect}>{children}</DetailTrack>
    </section>
  );
}
