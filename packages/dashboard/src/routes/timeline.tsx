import { createFileRoute, redirect } from '@tanstack/react-router';

import { timelineRedirect } from '../lib/activity.ts';

// Where /timeline leads: Activity, which replaced the Timeline page.
export const toActivity = ({ search }: { search: Record<string, unknown> }): never => {
  throw redirect(timelineRedirect(search));
};

export const Route = createFileRoute('/timeline')({
  beforeLoad: toActivity,
  validateSearch: (search: Record<string, unknown>) => search,
});
