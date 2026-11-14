import { createFileRoute, redirect } from '@tanstack/react-router';

// Where /compare leads: Activity, whose shared axis replaced the Compare page.
export const toActivity = (): never => {
  throw redirect({ to: '/activity' });
};

export const Route = createFileRoute('/compare')({
  beforeLoad: toActivity,
  validateSearch: (search: Record<string, unknown>) => search,
});
