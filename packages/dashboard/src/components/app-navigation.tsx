import { Link, useRouterState } from '@tanstack/react-router';
import { Bot, Cog, History, Server } from 'lucide-react';
import { createContext, useContext } from 'react';

import { cn } from '../lib/utils.ts';

export const ServiceAttentionCount = createContext(0);

// The destinations of both the phone navigation and the wide-screen sidebar.
export const NAV_ITEMS = [
  { icon: Server, label: 'Fleet', to: '/' },
  { icon: Cog, label: 'Services', to: '/services' },
  { icon: Bot, label: 'Agents', to: '/agents' },
  { icon: History, label: 'Timeline', to: '/timeline' },
] as const;

export type NavTo = (typeof NAV_ITEMS)[number]['to'];

// The item `path` belongs to: Compare, System, Condition, Session, and Service
// pages belong to Fleet.
export const activeNav = (path: string): NavTo =>
  path === '/services' || path === '/agents' || path === '/timeline' ? path : '/';

// The count of Services down or restarted beside the Services label, hidden at
// zero; screen readers get it in words.
export function ServicesBadge() {
  const count = useContext(ServiceAttentionCount);
  if (count === 0) {
    return null;
  }
  return (
    <>
      <span
        aria-hidden="true"
        className="rounded-full bg-primary/15 px-1.5 text-[11px] font-semibold text-primary"
      >
        {count}
      </span>
      <span className="sr-only">{count} Services down or restarted</span>
    </>
  );
}

// On a phone it is a raised tab bar with an icon over each label, and the
// current tab takes the primary color; on wider screens it is the header's text links.
export function AppNavigation() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const active = activeNav(path);
  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-card/92 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgb(0_0_0/0.35)] backdrop-blur-lg sm:static sm:gap-4 sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none sm:backdrop-blur-none"
    >
      {NAV_ITEMS.map(({ icon: Icon, label, to }) => (
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
          <span className="inline-flex items-center gap-1">
            {label}
            {to === '/services' && <ServicesBadge />}
          </span>
        </Link>
      ))}
    </nav>
  );
}
