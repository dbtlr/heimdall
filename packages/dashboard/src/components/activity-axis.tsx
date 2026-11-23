import { Link } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

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
import { TIME_AXIS_HEIGHT, TimeAxis } from './time-axis.tsx';

// The sizes of the axis's parts, in pixels. Each element takes its size from
// these, and the placeholder that holds the axis's room until the time zone is
// known adds them up above the legend, so the page does not shift when the zone
// arrives.
// A lane, top to bottom: its border, padding, marks strip, plot, and stretches
// strip, then padding. Every lane but the first of its group has the border.
const LANE_BORDER = 1;
const LANE_PADDING = 4;
const MARKS_STRIP_HEIGHT = 16;
const LANE_PLOT_HEIGHT = 44;
const STRETCHES_STRIP_HEIGHT = 8;
// On a phone a lane's label stacks above its track: one line and the gap under it.
// From sm up it sits beside the track, which is the taller.
const LANE_LABEL_LINE = 16;
const LANE_LABEL_GAP = 6;
// The line of the 12.5 px text of the unpaired divider and the legend, and the
// room above each.
const NOTE_LINE = 18.75;
const DIVIDER_MARGIN = 8;
const LEGEND_PADDING = 8;

// A change mark's glyph is 16 px (size-4); its hit area is a 24 px pseudo-element
// centered on it, which takes no room in the strip.
const MARK_HIT =
  "before:absolute before:top-1/2 before:left-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']";

// The height of a group of `count` lanes, with the stacked labels when `phone`.
const groupHeight = (count: number, phone: boolean): number =>
  count === 0
    ? 0
    : count *
        (2 * LANE_PADDING +
          MARKS_STRIP_HEIGHT +
          LANE_PLOT_HEIGHT +
          STRETCHES_STRIP_HEIGHT +
          (phone ? LANE_LABEL_LINE + LANE_LABEL_GAP : 0)) +
      (count - 1) * LANE_BORDER;

// The height of the axis over `lanes` above its legend, on a phone when
// `phone`: the paired lanes, the divider and the unpaired lanes when there are
// any, and the time axis. The legend wraps to as many lines as the width takes,
// so the placeholder shows the legend itself rather than adding up its lines.
const heightAboveLegend = (lanes: readonly AxisLane[], phone: boolean): number => {
  const unpaired = lanes.filter((lane) => lane.unpaired).length;
  return (
    groupHeight(lanes.length - unpaired, phone) +
    (unpaired === 0 ? 0 : DIVIDER_MARGIN + NOTE_LINE + groupHeight(unpaired, phone)) +
    TIME_AXIS_HEIGHT
  );
};

// The divider above the unpaired Systems' lanes, which are greyed: their
// history is kept, and no new Report arrives.
const UNPAIRED_DIVIDER =
  'flex items-center gap-3 text-[12.5px] font-normal text-muted-foreground before:flex-1 before:border-t before:border-dashed after:flex-1 after:border-t after:border-dashed';

// The unpaired Systems' lanes, greyed.
const UNPAIRED_LANES = 'text-muted-foreground saturate-50 [&_svg]:opacity-60';

// One bar per stretch of an agent Session under a lane's CPU, colored by
// Harness: a color that means nothing else.
function Stretches({ lane, window }: { lane: AxisLane; window: Window }) {
  return (
    <div
      aria-hidden="true"
      className="relative overflow-hidden"
      data-stretches
      style={{ height: STRETCHES_STRIP_HEIGHT }}
    >
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

// A button above the plot for each change line of the System: the list's
// glyph at the line's time. Picking one pins its moment.
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
            className={cn(
              'absolute top-0 z-10 flex size-4 -translate-x-1/2 items-center justify-center',
              MARK_HIT,
            )}
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

type Drag = {
  // The time under the pointer, undefined while the track has no width.
  at: (event: { clientX: number }) => number | undefined;
  onDrag: (at: number | undefined) => void;
  onPin: (at: number) => void;
};

// The pointer handlers of a lane's track. A press starts a drag whose line
// follows the pointer, and its release pins the time under it. A pointer the
// browser takes back, as when a touch scrolls the page, ends the drag with
// nothing pinned, so no line is left without a pin.
export const trackPointer = ({ at, onDrag, onPin }: Drag) => {
  let dragging = false;
  return {
    onPointerCancel: () => {
      dragging = false;
      onDrag(undefined);
    },
    onPointerDown: (event: {
      clientX: number;
      currentTarget: { setPointerCapture: (id: number) => void };
      pointerId: number;
    }) => {
      dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      onDrag(at(event));
    },
    onPointerMove: (event: { clientX: number }) => {
      if (dragging) {
        onDrag(at(event));
      }
    },
    onPointerUp: (event: { clientX: number }) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      const moment = at(event);
      onDrag(undefined);
      if (moment !== undefined) {
        onPin(moment);
      }
    },
  };
};

// A System's lane: CPU busy with the Session stretches under it and the
// change marks above it. Dragging across it, or arrow keys on it, pins a moment
// on this System.
function Lane({
  bucketMs,
  first,
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
  // The first lane of its group, which has no border above it.
  first: boolean;
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
  // The handlers keep the drag between renders; the latest props are read
  // through `props` so a re-render mid-drag does not end it.
  const props = useRef({ onDrag, onPin, system: lane.system, window });
  props.current = { onDrag, onPin, system: lane.system, window };
  const [pointer] = useState(() =>
    trackPointer({
      at: (event) => {
        const box = track.current?.getBoundingClientRect();
        return box === undefined || box.width === 0
          ? undefined
          : timeAtFraction((event.clientX - box.left) / box.width, props.current.window);
      },
      onDrag: (moment) => {
        props.current.onDrag(moment);
      },
      onPin: (moment) => {
        props.current.onPin({ at: moment, system: props.current.system });
      },
    }),
  );
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
    <div
      className={cn(LANE_GRID, 'relative items-center')}
      data-lane
      style={{
        borderTopWidth: first ? 0 : LANE_BORDER,
        paddingBlock: LANE_PADDING,
        rowGap: LANE_LABEL_GAP,
      }}
    >
      <Link
        className="max-w-full truncate text-xs font-semibold sm:text-sm"
        data-lane-label
        params={{ name: lane.system }}
        style={{ lineHeight: `${String(LANE_LABEL_LINE)}px` }}
        to="/systems/$name"
      >
        {lane.system}
      </Link>
      <div
        aria-label={`${lane.system}: drag or use the arrow keys to pin a moment`}
        className="relative min-w-0 cursor-col-resize touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-select"
        onKeyDown={step}
        ref={track}
        role="group"
        tabIndex={0}
        // Every handler trackPointer makes, so none is left unattached.
        {...pointer}
      >
        {/* Marks sit in a strip above the plot, so none covers a scale label or the limit label. */}
        <div className="relative" data-marks-strip style={{ height: MARKS_STRIP_HEIGHT }}>
          <Marks lines={lines} onPin={onPin} timeZone={timeZone} window={window} />
        </div>
        <div className="relative">
          <CpuPlot
            bucketMs={bucketMs}
            buckets={lane.buckets}
            height={LANE_PLOT_HEIGHT}
            label={`${lane.system} CPU busy`}
            limits={
              lane.cpuLimit === undefined
                ? []
                : [
                    {
                      color: 'var(--status-warning)',
                      label: `${String(lane.cpuLimit)}% limit`,
                      value: lane.cpuLimit,
                    },
                  ]
            }
            window={window}
          />
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
    <p
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground"
      data-axis-legend
      style={{ lineHeight: `${String(NOTE_LINE)}px`, paddingTop: LEGEND_PADDING }}
    >
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

type AxisProps = {
  bucketMs: number;
  lanes: readonly AxisLane[];
  lines: readonly ActivityLine[];
  onPin: (pin: Pin) => void;
  pin: Pin | undefined;
  window: Window;
};

// The axis once the viewer's zone is known: the paired Systems' lanes, then
// the unpaired ones greyed below a divider, the ticks, and the legend.
export function ActivityAxisBody({
  bucketMs,
  lanes,
  lines,
  onPin,
  pin,
  timeZone,
  window,
}: AxisProps & { timeZone: string }) {
  // While a drag is under way the line follows it; the pin lands on release.
  const [drag, setDrag] = useState<number | undefined>();
  const linesOf = Map.groupBy(lines, (line) => line.system);
  const laneOf = (lane: AxisLane, index: number) => (
    <Lane
      bucketMs={bucketMs}
      first={index === 0}
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
  );
  const paired = lanes.filter((lane) => !lane.unpaired);
  const unpaired = lanes.filter((lane) => lane.unpaired);
  return (
    <div className="[--lane-label:120px]">
      {paired.map(laneOf)}
      {unpaired.length > 0 && (
        <>
          <h3
            className={UNPAIRED_DIVIDER}
            data-unpaired-divider
            style={{ lineHeight: `${String(NOTE_LINE)}px`, marginTop: DIVIDER_MARGIN }}
          >
            Unpaired, history kept
          </h3>
          <div className={UNPAIRED_LANES}>{unpaired.map(laneOf)}</div>
        </>
      )}
      <TimeAxis ticks={spanTicks(window, timeZone)} window={window} />
      <AxisLegend />
    </div>
  );
}

// A lane for each System on one time axis over the range that ends now: CPU
// busy, the Sessions running, and a mark for each change. A pinned moment is
// the line across every lane. Until the zone is known it holds the axis's room
// above the legend and shows the legend, which needs no zone.
export function ActivityAxis(props: AxisProps) {
  const timeZone = useTimeZone();
  return timeZone === undefined ? (
    <>
      <div className="max-sm:hidden" style={{ height: heightAboveLegend(props.lanes, false) }} />
      <div className="sm:hidden" style={{ height: heightAboveLegend(props.lanes, true) }} />
      <AxisLegend />
    </>
  ) : (
    <ActivityAxisBody {...props} timeZone={timeZone} />
  );
}
