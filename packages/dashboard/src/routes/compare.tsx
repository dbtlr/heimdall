import { createFileRoute, redirect } from '@tanstack/react-router';

import type { ActivityRange } from '../server/activity-types.ts';

// Where /compare leads: Activity, whose shared axis replaced the Compare page,
// on the Activity range that holds Compare's. Compare opened on 24 h, and its
// 6 h and 12 h fit in Activity's 24 h; its unpaired switch has no counterpart,
// as Activity always shows the unpaired Systems.
export const toActivity = ({ search }: { search: Record<string, unknown> }): never => {
  const range: ActivityRange = search.range === '7d' ? '7d' : '24h';
  throw redirect({ search: { range }, to: '/activity' });
};

export const Route = createFileRoute('/compare')({
  beforeLoad: toActivity,
  validateSearch: (search: Record<string, unknown>) => search,
});
