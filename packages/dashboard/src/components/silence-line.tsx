import { silenceLeft } from '../lib/time.ts';
import { DateTime, InZone } from './date-time.tsx';

type Silence = { now: number; until: number | undefined };

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
    <div className="mb-2 card-surface rounded-xl border border-dashed border-dim px-3.5 py-2.5">
      <SilenceText now={now} until={until} />. Conditions still show and count toward health.
    </div>
  );
}
