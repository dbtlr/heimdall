import { Link } from '@tanstack/react-router';

import type { Window } from '../lib/time.ts';
import { unpairedLinkText } from '../lib/unpaired.ts';
import type { Lane } from '../server/fleet-overview-types.ts';
import { FleetLane } from './fleet-lane.tsx';

const LINK = 'text-[#4a90ea] underline decoration-[#4a90ea]/45 underline-offset-[3px]';

// The link below the lanes that shows the unpaired Systems or, once shown, hides
// them. The choice lives in the URL as `unpaired`. Nothing without a count, and
// no way back when nothing is shown.
export function UnpairedLink({ count, shown }: { count: number; shown: boolean }) {
  if (count === 0 && !shown) {
    return null;
  }
  return (
    <p className="border-t pt-2 pb-1">
      <Link
        className={LINK}
        resetScroll={false}
        search={(previous) => ({ ...previous, unpaired: shown ? undefined : true })}
        to="."
      >
        {unpairedLinkText(count, shown)}
      </Link>
    </p>
  );
}

// The Systems that were unpaired, greyed below a divider: their history is
// kept, and no new Report arrives. Each lane opens that System's page.
export function UnpairedLanes({
  lanes,
  now,
  timeZone,
  window,
}: {
  lanes: readonly Lane[];
  now: number;
  timeZone: string;
  window: Window;
}) {
  return (
    <>
      <div className="mt-3.5 flex items-center gap-3 text-[12.5px] text-muted-foreground before:flex-1 before:border-t before:border-dashed after:flex-1 after:border-t after:border-dashed">
        Unpaired, history kept
      </div>
      {lanes.length === 0 ? (
        <p className="py-3 text-muted-foreground">No System is unpaired.</p>
      ) : (
        lanes.map((lane) => (
          <div
            className="opacity-60 saturate-50 transition-opacity hover:opacity-85"
            key={lane.name}
          >
            <FleetLane lane={lane} now={now} timeZone={timeZone} window={window} />
          </div>
        ))
      )}
    </>
  );
}
