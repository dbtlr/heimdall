import { Link, useRouterState } from '@tanstack/react-router';
import { Bot, History, Server } from 'lucide-react';

import { cn } from '../lib/utils.ts';

// Compare and System detail belong to Fleet in the phone navigation.
// On a phone it is a raised tab bar with an icon over each label, and the
// current tab takes the primary color; on wider screens it is the header's text links.
export function AppNavigation() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const active = ['/agents', '/timeline'].includes(path) ? path : '/';
  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-card/92 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgb(0_0_0/0.35)] backdrop-blur-lg sm:static sm:gap-4 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none"
    >
      {(
        [
          { icon: Server, label: 'Fleet', to: '/' },
          { icon: Bot, label: 'Agents', to: '/agents' },
          { icon: History, label: 'Timeline', to: '/timeline' },
        ] as const
      ).map(({ icon: Icon, label, to }) => (
        <Link
          aria-current={active === to ? 'page' : undefined}
          className={cn(
            'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[13px] font-medium tracking-[0.02em] text-muted-foreground sm:min-h-11 sm:flex-none sm:text-base sm:font-normal sm:tracking-normal',
            active === to && 'font-semibold text-primary sm:font-semibold sm:text-foreground',
          )}
          key={to}
          to={to}
        >
          <Icon aria-hidden="true" className="size-6 sm:hidden" />
          {label}
        </Link>
      ))}
    </nav>
  );
}
