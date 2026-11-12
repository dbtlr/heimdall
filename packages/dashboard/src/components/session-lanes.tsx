import { harnessColor, harnessName } from '../lib/lane.ts';
import { formatCost } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import type { SessionRow } from '../server/system-detail-types.ts';
import { DetailTrack } from './detail-track.tsx';
import { MoreItems } from './more-items.tsx';
import { SessionBars, SessionLink } from './session-rows.tsx';

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
  return (
    <DetailTrack className="overflow-hidden">
      <SessionBars
        label={(session) => (
          // A link inside a track that picks a time: following it picks none.
          // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
          <span
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <SessionLink session={session} system={system} /> · {formatCost(session.costUsd)}
          </span>
        )}
        labelClassName="max-w-[60%] truncate"
        sessions={sessions}
        window={window}
      />
    </DetailTrack>
  );
}

// When a Session last worked: the end of its last stretch, which for one still
// going is the newest time the Hub holds.
const lastActive = (session: SessionRow) => session.stretches.at(-1)?.endedAt ?? 0;

// The agent Sessions of the window, one lane each in their Harness's color:
// solid where a process is linked, dashed where ambiguous, outlined where
// unmatched. The most recently active few show, in the order they started;
// the rest open from a disclosure.
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
  const recent = new Set(
    sessions.toSorted((a, b) => lastActive(b) - lastActive(a)).slice(0, LANES_SHOWN),
  );
  const folded = sessions.filter((session) => !recent.has(session));
  return (
    <>
      <Lanes
        sessions={sessions.filter((session) => recent.has(session))}
        system={system}
        window={window}
      />
      {folded.length > 0 && (
        <MoreItems label={`Show ${String(folded.length)} more Sessions`}>
          <Lanes sessions={folded} system={system} window={window} />
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
