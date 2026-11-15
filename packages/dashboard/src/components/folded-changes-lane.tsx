import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

import { LEVEL_FILL } from '../lib/conditions.ts';
import { binMarkPercent, changeCounts, kindRows } from '../lib/long-history.ts';
import { levelSegments, systemEvents } from '../lib/system-events.ts';
import { spanBox, xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { SystemDetail } from '../server/system-detail-types.ts';
import { EventLine } from './changes-lane.tsx';
import { DetailTrack } from './detail-track.tsx';

const ROW_PX = 13;
// The latest events named under the lane; the rest are on Activity.
const EVENTS_SHOWN = 3;
// Activity's longest range, which a link to it opens.
const ACTIVITY_REACH_MS = 30 * 24 * 60 * 60_000;

// A row of the lane: its label, beside the track in the gutter or over the
// track's left end on a phone, and its marks.
function Row({
  children,
  inside,
  label,
}: {
  children?: ReactNode;
  inside: boolean;
  label: string;
}) {
  return (
    <div className="relative" style={{ height: ROW_PX }}>
      <span
        className={cn(
          'absolute top-0 z-10 truncate text-[11px] leading-[13px] text-muted-foreground',
          inside
            ? 'left-0 max-w-[60%] rounded-sm bg-card/85 px-0.5'
            : 'right-full mr-1.5 max-w-[104px] text-right whitespace-nowrap',
        )}
        title={label}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

// The Conditions and changes lane over a long range, folded so a year stays
// legible: a diamond for each day's or week's Service changes with their count,
// in the middle of the part of its bin on the chart, a ring at each reboot,
// then one row per Condition kind, the kind raised most often first, with its
// count and its spans colored by level. The latest few events follow as a
// line, with a link to the rest on Activity. The bins, the reboots, and the
// Conditions start with the first bucket, which may begin before the window,
// so the lane shows what that bucket's inspector lists; a mark there stands at
// the window's start.
export function FoldedChangesLane({
  detail,
  labelsInside = false,
  window,
}: {
  detail: Pick<
    SystemDetail,
    'changes' | 'conditions' | 'edges' | 'long' | 'name' | 'now' | 'paired'
  >;
  labelsInside?: boolean;
  window: Window;
}) {
  const firstBucket = {
    from: Math.min(window.from, detail.edges?.[0] ?? window.from),
    to: window.to,
  };
  const rows = kindRows(detail.conditions, { paired: detail.paired, window: firstBucket });
  const counts = changeCounts(detail, window, detail.long?.changeEdges ?? []);
  const reboots = (detail.long?.reboots ?? []).filter((t) => t <= window.to);
  const events = systemEvents(detail, window);
  return (
    <>
      <DetailTrack>
        <div className="grid gap-px">
          <Row inside={labelsInside} label="Changes">
            {counts.map(({ count, end, t }) => (
              <span
                className="absolute top-0 flex -translate-x-1/2 items-center gap-0.5 text-[10px] leading-[13px] text-muted-foreground"
                key={t}
                style={{ left: `${String(binMarkPercent({ end, t }, window))}%` }}
                title={`${String(count)} ${count === 1 ? 'change' : 'changes'}`}
              >
                <i className="inline-block size-2 rotate-45 bg-foreground/70" />
                {count > 1 && count}
              </span>
            ))}
          </Row>
          <Row inside={labelsInside} label="Reboots">
            {reboots.map((t) => (
              <i
                className="absolute top-0.5 size-2 -translate-x-1/2 rounded-full border border-link"
                key={t}
                style={{ left: `${String(xPercent(Math.max(t, window.from), window))}%` }}
                title="Rebooted"
              />
            ))}
          </Row>
          {rows.map((row) => (
            <Row inside={labelsInside} key={row.kind} label={`${row.name} ${String(row.count)}×`}>
              {row.marks.flatMap((mark) =>
                levelSegments(mark, mark.clearedAt ?? window.to).map((segment) => {
                  const { left, width } = spanBox(segment, window);
                  return (
                    <div
                      className={cn(
                        'absolute top-0.5 h-2 min-w-[3px] rounded-[2px]',
                        LEVEL_FILL[segment.level],
                      )}
                      key={`${mark.id}-${String(segment.start)}`}
                      style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
                    />
                  );
                }),
              )}
            </Row>
          ))}
        </div>
      </DetailTrack>
      {events.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-4">
          <EventLine events={events.slice(0, EVENTS_SHOWN)} now={detail.now} />
          <Link
            className="mt-1.5 text-[12.5px] text-link hover:underline"
            search={{ range: '30d', system: detail.name }}
            to="/activity"
          >
            {window.to - window.from > ACTIVITY_REACH_MS
              ? 'The last 30 days in Activity ›'
              : `All ${String(events.length)} events in Activity ›`}
          </Link>
        </div>
      )}
    </>
  );
}
