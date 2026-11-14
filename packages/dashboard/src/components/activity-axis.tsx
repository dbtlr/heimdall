import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';

import { timeAtFraction } from '../lib/activity-moment.ts';
import { lineWords } from '../lib/activity.ts';
import type { ActivityLine } from '../lib/activity.ts';
import { spanTicks } from '../lib/axis.ts';
import { harnessColor, harnessName } from '../lib/lane.ts';
import { LANE_GRID } from '../lib/layout.ts';
import { formatClock, pinnedX, spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { cn } from '../lib/utils.ts';
import type { AxisLane } from '../server/activity-types.ts';
import { KindGlyph } from './activity-list.tsx';
import type { Pin } from './activity-list.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { TimeAxis } from './time-axis.tsx';

const LANE_HEIGHT = 34;

// One bar per stretch of an agent Session under a lane's CPU, colored by
// Harness: a color that means nothing else.
function Stretches({ lane, window }: { lane: AxisLane; window: Window }) {
  return (
    <div aria-hidden="true" className="relative h-2 overflow-hidden">
      {lane.stretches.map((stretch) => {
        const { left, width } = spanBox({ end: stretch.endedAt, start: stretch.startedAt }, window);
        return (
          <div
            className="absolute inset-y-px min-w-[3px] rounded-[2px]"
            key={`${stretch.harness}-${String(stretch.startedAt)}`}
            style={{
              backgroundColor: harnessColor(stretch.harness),
              left: `${String(left)}%`,
              width: `${String(width)}%`,
            }}
          />
        );
      })}
    </div>
  );
}

// A button over the plot for each change line of the System: the list's glyph
// at the line's time. Picking one pins its moment.
function Marks({
  lines,
  onPin,
  timeZone,
  window,
}: {
  lines: readonly ActivityLine[];
  onPin: (pin: Pin) => void;
  timeZone: string;
  window: Window;
}) {
  return (
    <>
      {lines.map((line) => {
        const [lead] = line.events;
        const x = pinnedX(line.at, window);
        if (lead === undefined || x === undefined) {
          return null;
        }
        const words = lineWords(line);
        return (
          <button
            aria-label={`${formatClock(line.at, timeZone)} ${words.title} ${words.subject}`.trim()}
            className="absolute top-0 z-10 flex size-5 -translate-x-1/2 items-center justify-center"
            key={`${String(line.at)}-${lead.kind}`}
            onClick={() => {
              onPin({ at: line.at, system: line.system });
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            style={{ left: `${String(x)}%` }}
            type="button"
          >
            <KindGlyph event={lead} words={words} />
          </button>
        );
      })}
    </>
  );
}

// A System's lane: CPU busy with the Session stretches under it and the
// change marks over it. Dragging across it, or arrow keys on it, pins a moment
// on this System.
function Lane({
  bucketMs,
  lane,
  lines,
  onDrag,
  onPin,
  pin,
  shown,
  timeZone,
  window,
}: {
  bucketMs: number;
  lane: AxisLane;
  lines: readonly ActivityLine[];
  onDrag: (at: number | undefined) => void;
  onPin: (pin: Pin) => void;
  pin: Pin | undefined;
  shown: number | undefined;
  timeZone: string;
  window: Window;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const at = (event: PointerEvent) => {
    const box = track.current?.getBoundingClientRect();
    return box === undefined || box.width === 0
      ? undefined
      : timeAtFraction((event.clientX - box.left) / box.width, window);
  };
  const step = (event: KeyboardEvent) => {
    const direction = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (direction === undefined) {
      return;
    }
    event.preventDefault();
    const from = pin?.system === lane.system ? pin.at : window.to;
    onPin({
      at: timeAtFraction(
        (from + direction * bucketMs - window.from) / (window.to - window.from),
        window,
      ),
      system: lane.system,
    });
  };
  return (
    <div className={cn(LANE_GRID, 'relative items-center border-t py-1 first:border-t-0')}>
      <Link
        className="absolute top-1 left-0 z-20 max-w-[8rem] truncate rounded-md bg-card/85 px-1.5 text-xs font-semibold sm:static sm:max-w-none sm:bg-transparent sm:px-0 sm:text-sm"
        params={{ name: lane.system }}
        to="/systems/$name"
      >
        {lane.system}
      </Link>
      <div
        aria-label={`${lane.system}: drag or use the arrow keys to pin a moment`}
        className="relative min-w-0 cursor-col-resize touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-select"
        onKeyDown={step}
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          onDrag(at(event));
        }}
        onPointerMove={(event) => {
          if (dragging.current) {
            onDrag(at(event));
          }
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          const moment = at(event);
          onDrag(undefined);
          if (moment !== undefined) {
            onPin({ at: moment, system: lane.system });
          }
        }}
        ref={track}
        role="group"
        tabIndex={0}
      >
        <div className="relative">
          <CpuPlot
            bucketMs={bucketMs}
            buckets={lane.buckets}
            height={LANE_HEIGHT}
            label={`${lane.system} CPU busy`}
            limits={
              lane.cpuLimit === undefined
                ? []
                : [
                    {
                      color: 'var(--status-warning)',
                      label: `${String(lane.cpuLimit)}%`,
                      value: lane.cpuLimit,
                    },
                  ]
            }
            window={window}
          />
          <Marks lines={lines} onPin={onPin} timeZone={timeZone} window={window} />
        </div>
        <Stretches lane={lane} window={window} />
        {shown !== undefined && <PinLine at={shown} window={window} />}
      </div>
    </div>
  );
}

// The vertical line at the pinned moment, in the selection color.
function PinLine({ at, window }: { at: number; window: Window }) {
  const x = pinnedX(at, window);
  return x === undefined ? null : (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-select"
      style={{ left: `${String(x)}%` }}
    />
  );
}

const SWATCH = 'inline-block h-2 w-3.5 flex-none rounded-[2px]';
const LEGEND_ITEM = 'inline-flex items-center gap-[5px]';

// What the axis's lines, bars, and marks mean.
function AxisLegend() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-[12.5px] text-muted-foreground">
      <span className={LEGEND_ITEM}>
        <i className="inline-block h-[7px] w-3.5 flex-none rounded-[2px] border-t-2 border-plot bg-plot/25" />
        CPU busy, 0 to 100%, dashed at the Hub&apos;s limit
      </span>
      {['claude-code', 'codex'].map((harness) => (
        <span className={LEGEND_ITEM} key={harness}>
          <i className={SWATCH} style={{ backgroundColor: harnessColor(harness) }} />
          {harnessName(harness)} Session
        </span>
      ))}
      <span className={LEGEND_ITEM}>
        <ConditionGlyph kind="alert" />
        <ConditionGlyph kind="warning" />
        <ConditionGlyph kind="note" />
        Condition
      </span>
      <span className={LEGEND_ITEM}>
        <svg aria-hidden="true" className="size-[11px] fill-plot" viewBox="0 0 12 12">
          <rect height="9" width="9" x="1.5" y="1.5" />
        </svg>
        version
        <svg aria-hidden="true" className="size-[11px]" viewBox="0 0 12 12">
          <circle className="fill-none stroke-plot stroke-[1.8]" cx="6" cy="6" r="4.2" />
        </svg>
        Service stop
        <svg aria-hidden="true" className="size-[11px] fill-plot" viewBox="0 0 12 12">
          <circle cx="6" cy="6" r="4.5" />
        </svg>
        alert sent
      </span>
    </p>
  );
}

// A lane for each System on one time axis over the range that ends now: CPU
// busy, the Sessions running, and a mark for each change. A pinned moment is
// the line across every lane.
export function ActivityAxis({
  bucketMs,
  lanes,
  lines,
  onPin,
  pin,
  window,
}: {
  bucketMs: number;
  lanes: readonly AxisLane[];
  lines: readonly ActivityLine[];
  onPin: (pin: Pin) => void;
  pin: Pin | undefined;
  window: Window;
}) {
  const timeZone = useTimeZone();
  // While a drag is under way the line follows it; the pin lands on release.
  const [drag, setDrag] = useState<number | undefined>();
  if (timeZone === undefined) {
    return <div style={{ height: lanes.length * (LANE_HEIGHT + 16) }} />;
  }
  const linesOf = Map.groupBy(lines, (line) => line.system);
  return (
    <div className="[--lane-label:120px]">
      {lanes.map((lane) => (
        <Lane
          bucketMs={bucketMs}
          key={lane.system}
          lane={lane}
          lines={linesOf.get(lane.system) ?? []}
          onDrag={setDrag}
          onPin={onPin}
          pin={pin}
          shown={drag ?? pin?.at}
          timeZone={timeZone}
          window={window}
        />
      ))}
      <TimeAxis ticks={spanTicks(window, timeZone)} window={window} />
      <AxisLegend />
    </div>
  );
}
