import { Link } from '@tanstack/react-router';

import type { Window } from '../lib/time.ts';
import { unpairedLinkText } from '../lib/unpaired.ts';
import type { Attention } from '../server/attention-types.ts';
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

// The Systems that were unpaired, greyed below a divider (plots dimmed, text in
// the muted colour, which keeps its contrast): their history is
// kept, and no new Report arrives. Each lane opens that System's page.
export function UnpairedLanes({
  itemsOf,
  lanes,
  now,
  window,
}: {
  itemsOf: (system: string) => Attention[];
  lanes: readonly Lane[];
  now: number;
  window: Window;
}) {
  return (
    <>
      <h2 className="mt-3.5 flex items-center gap-3 text-[12.5px] font-normal text-muted-foreground before:flex-1 before:border-t before:border-dashed after:flex-1 after:border-t after:border-dashed">
        Unpaired, history kept
      </h2>
      {lanes.length === 0 ? (
        <p className="py-3 text-muted-foreground">No System is unpaired.</p>
      ) : (
        lanes.map((lane) => (
          <div
            className="text-muted-foreground saturate-50 [&_svg]:opacity-60 [&_svg]:transition-opacity hover:[&_svg]:opacity-90"
            key={lane.name}
          >
            <FleetLane items={itemsOf(lane.name)} lane={lane} now={now} window={window} />
          </div>
        ))
      )}
    </>
  );
}
