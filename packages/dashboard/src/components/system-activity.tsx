import { Link } from '@tanstack/react-router';

import { groupActivity } from '../lib/activity.ts';
import type { Activity } from '../server/activity-types.ts';
import { ActivityList } from './activity-list.tsx';

// A System's Activity tab: the Activity page's list for this System alone over
// its last 7 days, with a link to the page for longer ranges and the filters.
export function SystemActivity({ activity, system }: { activity: Activity; system: string }) {
  const lines = groupActivity(activity.events);
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">Activity</h2>
        <Link className="text-sm text-link hover:underline" search={{ system }} to="/activity">
          Longer ranges and filters →
        </Link>
      </div>
      <section aria-label="Changes" className="mt-3 card-surface rounded-xl border px-4 py-4">
        <p className="mb-3 text-[12.5px] text-muted-foreground">
          The last 7 days, newest first. Changes within 2 minutes share a line.
        </p>
        {lines.length === 0 ? (
          <p>Nothing changed in the last 7 days.</p>
        ) : (
          <ActivityList lines={lines} now={activity.now} unpaired={new Set(activity.unpaired)} />
        )}
      </section>
    </>
  );
}
