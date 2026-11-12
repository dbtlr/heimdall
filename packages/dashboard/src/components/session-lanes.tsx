import { costPlacement } from '../lib/detail.ts';
import { harnessColor, harnessName } from '../lib/lane.ts';
import { clockSpan, phraseTitle } from '../lib/phrase.ts';
import { formatCost, spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { cn } from '../lib/utils.ts';
import type { SessionRow } from '../server/system-detail-types.ts';
import { DetailTrack } from './detail-track.tsx';
import { MoreItems } from './more-items.tsx';
import { costStyle, LINK_STYLE, SessionLink, sessionKey, what } from './session-rows.tsx';

const ROW_PX = 22;
// Lanes shown before the rest wait behind a disclosure.
const LANES_SHOWN = 6;

// One lane of the track for each Session, with a bar for each stretch of it
// and its name and cost beside the last. The track spans its card, so the
// lanes line up with the plots above and below on the shared axis.
function Lanes({
  sessions,
  system,
  window,
}: {
  sessions: readonly SessionRow[];
  system: string;
  window: Window;
}) {
  const timeZone = useTimeZone();
  return (
    <DetailTrack className="overflow-hidden">
      {sessions.map((session, row) => {
        const top = row * ROW_PX + 3;
        const place = costPlacement(session, window);
        return (
          <div key={sessionKey(session)} style={{ color: harnessColor(session.harness) }}>
            {session.stretches.map((stretch) => {
              const { left, width } = spanBox(
                { end: stretch.endedAt, start: stretch.startedAt },
                window,
              );
              return (
                <div
                  className={cn('absolute h-4 min-w-[3px] rounded-[2px]', LINK_STYLE[stretch.link])}
                  key={stretch.startedAt}
                  style={{ left: `${String(left)}%`, top, width: `${String(width)}%` }}
                  title={phraseTitle(
                    [
                      `${what(session)}, ${harnessName(session.harness)}, `,
                      ...clockSpan(stretch.startedAt, stretch.endedAt),
                      `, process ${stretch.link}`,
                    ],
                    timeZone,
                  )}
                />
              );
            })}
            {/* A link inside a track that picks a time: following it picks none. */}
            {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <span
              className={cn(
                'absolute max-w-[60%] truncate text-xs whitespace-nowrap text-muted-foreground tabular-nums',
                'over' in place && 'rounded-[3px] bg-background px-1',
              )}
              onClick={(event) => {
                event.stopPropagation();
              }}
              style={costStyle(place, top)}
            >
              <SessionLink session={session} system={system} /> · {formatCost(session.costUsd)}
            </span>
          </div>
        );
      })}
      <div style={{ height: sessions.length * ROW_PX }} />
    </DetailTrack>
  );
}

// The agent Sessions of the window, one lane each in their Harness's color:
// solid where a process is linked, dashed where ambiguous, outlined where
// unmatched. Beyond the first few, the rest open from a disclosure.
export function SessionLanes({
  sessions,
  system,
  window,
}: {
  sessions: readonly SessionRow[];
  system: string;
  window: Window;
}) {
  if (sessions.length === 0) {
    return <p className="py-3 text-[13px] text-muted-foreground">No Session in this range.</p>;
  }
  return (
    <>
      <Lanes sessions={sessions.slice(0, LANES_SHOWN)} system={system} window={window} />
      {sessions.length > LANES_SHOWN && (
        <MoreItems label={`Show ${String(sessions.length - LANES_SHOWN)} more Sessions`}>
          <Lanes sessions={sessions.slice(LANES_SHOWN)} system={system} window={window} />
        </MoreItems>
      )}
    </>
  );
}

// The Harnesses the Sessions ran in, each with its color, as a legend.
export function HarnessLegend({ sessions }: { sessions: readonly SessionRow[] }) {
  const harnesses = [...new Set(sessions.map(({ harness }) => harness))].toSorted();
  return (
    <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      {harnesses.map((harness) => (
        <span className="flex items-center gap-1.5" key={harness}>
          <i
            className="inline-block size-2 rounded-[2px]"
            style={{ backgroundColor: harnessColor(harness) }}
          />
          {harnessName(harness)}
        </span>
      ))}
    </p>
  );
}
