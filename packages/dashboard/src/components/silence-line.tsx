import { formatSpan } from '../lib/time.ts';
import { DateTime, InZone } from './date-time.tsx';

type Silence = { now: number; until: number | undefined };

const MINUTE_MS = 60_000;

// The time left on a silence: "2 h", "1 h 31 min", never below "1 min". Rounds up
// to the minute, as `heimdall-hub silence` lists it, so a silence just set for
// 2 h reads as 2 h. formatSpan then shows two units, so from a day on the
// minutes are dropped.
export const silenceLeft = (now: number, until: number): string =>
  formatSpan(Math.max(1, Math.ceil((until - now) / MINUTE_MS)) * MINUTE_MS);

// "Alerts silenced until <when> · <span> left", for the banner. "until <when>"
// waits for the viewer's zone; the rest reads whole without it.
function SilenceText({ now, until }: { now: number; until: number }) {
  return (
    <>
      Alerts silenced
      <InZone>
        {() => (
          <>
            {' '}
            until <DateTime at={until} format="ahead" now={now} />
          </>
        )}
      </InZone>{' '}
      · {silenceLeft(now, until)} left
    </>
  );
}

// Across the top of a silenced System's page, on every tab. A silence holds
// pushes only: Conditions still show and count toward health.
export function SilenceBanner({ now, until }: Silence) {
  return until === undefined ? null : (
    <div className="mb-2 rounded-lg border border-dashed border-[#5a6690] bg-card px-3.5 py-2.5">
      <SilenceText now={now} until={until} />. Conditions still show and count toward health.
    </div>
  );
}
