import { Link, useRouterState } from '@tanstack/react-router';

import { cn } from '../lib/utils.ts';

// Compare and System detail belong to Fleet in the phone navigation.
export function AppNavigation() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const active = ['/agents', '/timeline'].includes(path) ? path : '/';
  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t bg-background px-2 pt-1 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:static sm:gap-4 sm:border-0 sm:p-0"
    >
      {(
        [
          { label: 'Fleet', to: '/' },
          { label: 'Agents', to: '/agents' },
          { label: 'Timeline', to: '/timeline' },
        ] as const
      ).map(({ label, to }) => (
        <Link
          aria-current={active === to ? 'page' : undefined}
          className={cn(
            'flex min-h-11 min-w-20 items-center justify-center rounded-md px-3 text-base text-muted-foreground sm:min-w-0 sm:px-0',
            active === to && 'font-semibold text-foreground',
          )}
          key={to}
          to={to}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
