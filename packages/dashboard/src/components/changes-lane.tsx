import { LEVEL_FILL } from '../lib/conditions.ts';
import { whenAt } from '../lib/phrase.ts';
import { levelSegments, laneConditions, packRows, systemEvents } from '../lib/system-events.ts';
import type { SystemEvent } from '../lib/system-events.ts';
import { spanBox, xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { SystemDetail } from '../server/system-detail-types.ts';
import { PhraseText } from './date-time.tsx';
import { DetailTrack } from './detail-track.tsx';
import { MoreItems } from './more-items.tsx';

const ROW_PX = 11;
const DIAMOND_ROW_PX = 14;
// Events listed under the lane, the latest first, before the rest wait behind
// a disclosure.
const EVENTS_SHOWN = 6;

const LEVELS = [
  ['warning', 'warning'],
  ['note', 'note'],
  ['alert', 'alert'],
] as const;

// The lane's key: the level colors and the change mark.
export function ChangesLegend() {
  return (
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      {LEVELS.map(([level, name]) => (
        <span className="flex items-center gap-1.5" key={level}>
          <i className={cn('inline-block h-2 w-3 rounded-[2px]', LEVEL_FILL[level])} />
          {name}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <i className="inline-block size-2 rotate-45 bg-foreground/70" />
        change
      </span>
    </p>
  );
}

// One event of the line under the lane: when, then what.
function EventItem({ event, now }: { event: SystemEvent; now: number }) {
  return (
    <li className="min-w-0">
      <b className="font-semibold tabular-nums">
        <PhraseText
          phrase={
            event.kind === 'condition' && event.end !== undefined
              ? [whenAt(event.at, now), ' to ', whenAt(event.end, now)]
              : [whenAt(event.at, now)]
          }
        />
      </b>{' '}
      <span className="text-muted-foreground">{event.text}</span>
    </li>
  );
}

// The System's Conditions open in the window as spans, colored by level and
// stacked where they overlap, a diamond for each Service change, and the same
// events as a line under them, the latest first.
export function ChangesLane({
  detail,
  window,
}: {
  detail: Pick<SystemDetail, 'changes' | 'conditions' | 'now' | 'paired'>;
  window: Window;
}) {
  const marks = laneConditions(detail.conditions, { paired: detail.paired, window });
  const events = systemEvents(detail, window);
  const rows = packRows(
    marks.map((mark) => ({ end: mark.clearedAt ?? window.to, start: mark.raisedAt })),
  );
  const depth = Math.max(0, ...rows.map((row) => row + 1));
  const changes = events.filter((event) => event.kind === 'change');
  const height = DIAMOND_ROW_PX + depth * ROW_PX;
  return (
    <>
      {events.length === 0 ? (
        <p className="py-2 text-[13px] text-muted-foreground">
          No Condition or change in this range.
        </p>
      ) : (
        <>
          <DetailTrack className="overflow-hidden">
            <div style={{ height }}>
              {changes.map((event) => (
                <i
                  className="absolute top-0.5 size-2 -translate-x-1/2 rotate-45 bg-foreground/70"
                  key={`${String(event.at)}-${event.text}`}
                  style={{ left: `${String(xPercent(event.at, window))}%` }}
                  title={event.text}
                />
              ))}
              {marks.map((mark, index) =>
                levelSegments(mark, mark.clearedAt ?? window.to).map((segment) => {
                  const { left, width } = spanBox(segment, window);
                  return (
                    <div
                      className={cn(
                        'absolute h-2 min-w-[3px] rounded-[2px]',
                        LEVEL_FILL[segment.level],
                      )}
                      key={`${mark.id}-${String(segment.start)}`}
                      style={{
                        left: `${String(left)}%`,
                        top: DIAMOND_ROW_PX + (rows[index] ?? 0) * ROW_PX,
                        width: `${String(width)}%`,
                      }}
                    />
                  );
                }),
              )}
            </div>
          </DetailTrack>
          <EventLine events={events.slice(0, EVENTS_SHOWN)} now={detail.now} />
          {events.length > EVENTS_SHOWN && (
            <MoreItems label={`Show ${String(events.length - EVENTS_SHOWN)} earlier events`}>
              <EventLine events={events.slice(EVENTS_SHOWN)} now={detail.now} />
            </MoreItems>
          )}
        </>
      )}
    </>
  );
}

// The events as one wrapping line, in the order given.
function EventLine({ events, now }: { events: readonly SystemEvent[]; now: number }) {
  return (
    <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[12.5px]">
      {events.map((event) => (
        <EventItem event={event} key={`${String(event.at)}-${event.text}`} now={now} />
      ))}
    </ul>
  );
}
