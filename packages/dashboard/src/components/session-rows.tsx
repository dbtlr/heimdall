import { costPlacement } from '../lib/detail.ts';
import { harnessColor, harnessName } from '../lib/lane.ts';
import { formatClock, formatCost, spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Link } from '../server/fleet-overview-types.ts';
import type { SessionRow } from '../server/system-detail-types.ts';
import { DetailTrack } from './detail-track.tsx';
import { LANE_GRID } from './fleet-lane.tsx';

const ROW_PX = 22;

// As on the Fleet overview: solid when linked, a translucent fill with a
// dashed edge when ambiguous, an outline when unmatched.
const LINK_STYLE: Record<Link, string> = {
  ambiguous:
    'border-[1.5px] border-dashed border-current bg-[color-mix(in_srgb,currentColor_30%,transparent)]',
  linked: 'bg-current',
  unmatched: 'border border-current',
};

const swatch = (session: SessionRow) =>
  session.stretches.some((stretch) => stretch.link === 'linked')
    ? 'linked'
    : (session.stretches[0]?.link ?? 'linked');

const span = (session: SessionRow, timeZone: string, window: Window) => {
  const first = session.stretches[0]?.startedAt ?? window.from;
  const last = session.stretches.at(-1)?.endedAt ?? window.to;
  return `${formatClock(first, timeZone)} to ${last >= window.to - 60_000 ? 'now' : formatClock(last, timeZone)}`;
};

// Where a Session's cost sits, from where `costPlacement` puts it.
const costStyle = (place: ReturnType<typeof costPlacement>, top: number) => {
  if ('right' in place) {
    return { right: `calc(${String(place.right)}% + 6px)`, top };
  }
  return { left: `calc(${String('over' in place ? place.over : place.left)}% + 6px)`, top };
};

const what = (session: SessionRow) =>
  session.project ?? session.branch ?? `${harnessName(session.harness)} Session`;

// One row per agent Session on the stack's axis, with a bar for each of its
// stretches and its cost beside the last. A phone lists them under the bars.
export function SessionRows({
  sessions,
  timeZone,
  window,
}: {
  sessions: readonly SessionRow[];
  timeZone: string;
  window: Window;
}) {
  if (sessions.length === 0) {
    return null;
  }
  return (
    <section aria-label="Agent Sessions" className="border-t py-2.5">
      <div className={LANE_GRID}>
        <div className="hidden sm:block">
          {sessions.map((session) => (
            <p
              className="flex items-center gap-1.5 truncate text-[12.5px]"
              key={`${session.harness}-${session.sessionId}`}
              style={{ height: ROW_PX }}
            >
              {what(session)}
              {session.project !== undefined && session.branch !== undefined && (
                <span className="truncate text-muted-foreground">{session.branch}</span>
              )}
            </p>
          ))}
        </div>
        <DetailTrack className="overflow-hidden">
          {sessions.map((session, row) => {
            const top = row * ROW_PX + 3;
            const place = costPlacement(session, window);
            return (
              <div
                key={`${session.harness}-${session.sessionId}`}
                style={{ color: harnessColor(session.harness) }}
              >
                {session.stretches.map((stretch) => {
                  const { left, width } = spanBox(
                    { end: stretch.endedAt, start: stretch.startedAt },
                    window,
                  );
                  return (
                    <div
                      className={cn(
                        'absolute h-4 min-w-[3px] rounded-[2px]',
                        LINK_STYLE[stretch.link],
                      )}
                      key={stretch.startedAt}
                      style={{ left: `${String(left)}%`, top, width: `${String(width)}%` }}
                      title={`${what(session)}, ${harnessName(session.harness)}, ${formatClock(stretch.startedAt, timeZone)} to ${formatClock(stretch.endedAt, timeZone)}, process ${stretch.link}`}
                    />
                  );
                })}
                <span
                  className={cn(
                    'absolute hidden text-xs whitespace-nowrap text-muted-foreground sm:block',
                    'over' in place && 'rounded-[3px] bg-background px-1',
                  )}
                  style={costStyle(place, top)}
                >
                  {formatCost(session.costUsd)}
                </span>
              </div>
            );
          })}
          <div style={{ height: sessions.length * ROW_PX }} />
        </DetailTrack>
      </div>
      <ul className="mt-1.5 sm:hidden">
        {sessions.map((session) => (
          <li
            className="flex items-start gap-2 py-1 text-[13.5px]"
            key={`${session.harness}-${session.sessionId}`}
          >
            <i
              className={cn(
                'mt-[5px] inline-block h-2 w-3.5 flex-none rounded-[2px]',
                LINK_STYLE[swatch(session)],
              )}
              style={{ color: harnessColor(session.harness) }}
            />
            <span>
              <b className="font-semibold">{what(session)}</b>{' '}
              {session.project !== undefined && session.branch}
              <br />
              <span className="text-muted-foreground">
                {span(session, timeZone, window)}, {formatCost(session.costUsd)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
