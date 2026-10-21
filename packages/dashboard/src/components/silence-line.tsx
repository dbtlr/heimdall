import { formatSpan } from '../lib/time.ts';
import { DateTime, InZone } from './date-time.tsx';

type Silence = { now: number; until: number | undefined };

const MINUTE_MS = 60_000;

// "Alerts silenced until <when> · <span> left", shared by the card and the
// banner. "until <when>" waits for the viewer's zone; the rest reads whole
// without it. Time left rounds up, as `heimdall-hub silence` lists it, so a
// silence just set for 2 h reads as 2 h left.
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
      · {formatSpan(Math.ceil((until - now) / MINUTE_MS) * MINUTE_MS)} left
    </>
  );
}

// A Fleet card's line when the Hub holds alerts for that System (ADR-0020).
// Nothing without a silence.
export function SilenceLine({ now, until }: Silence) {
  return until === undefined ? null : (
    <p className="mt-1 text-sm text-muted-foreground">
      <SilenceText now={now} until={until} />
    </p>
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
