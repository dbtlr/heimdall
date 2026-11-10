import { Link, useRouterState } from '@tanstack/react-router';
import { Bot, Cog, Ellipsis, History, House } from 'lucide-react';
import { createContext, useContext } from 'react';

import { PHONE_TABS, phoneTabOf } from '../lib/sections.ts';
import type { PhoneTab } from '../lib/sections.ts';
import { cn } from '../lib/utils.ts';

export const ServiceAttentionCount = createContext(0);

const TAB_ICONS = { activity: History, agents: Bot, home: House, more: Ellipsis, services: Cog };

const TAB_PATHS: Record<PhoneTab, '/' | '/agents' | '/more' | '/services' | '/timeline'> = {
  activity: '/timeline',
  agents: '/agents',
  home: '/',
  more: '/more',
  services: '/services',
};

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
        className="rounded-full bg-primary/15 px-1.5 text-xs font-semibold text-primary"
      >
        {count}
      </span>
      <span className="sr-only">{count} Services down or restarted</span>
    </>
  );
}

// The phone's navigation: a raised tab bar at the bottom with an icon over each
// label, Home, Services, Agents, Activity, and More, and the tab the page
// belongs to in the primary color.
export function AppNavigation() {
  const location = useRouterState({ select: (state) => state.location });
  const active = phoneTabOf(location.pathname, location.search);
  return (
    <nav
      aria-label="Main navigation"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-bar/92 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgb(0_0_0/0.35)] backdrop-blur-lg"
    >
      {PHONE_TABS.map(({ key, label }) => {
        const Icon = TAB_ICONS[key];
        return (
          <Link
            // Only an exact match may make the router mark a tab too, so the
            // tab the page belongs to is the one marked.
            activeOptions={{ exact: true }}
            aria-current={active === key ? 'page' : undefined}
            className={cn(
              'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[13px] font-medium tracking-[0.02em] text-muted-foreground',
              active === key && 'font-semibold text-primary',
            )}
            key={key}
            to={TAB_PATHS[key]}
          >
            <Icon aria-hidden="true" className="size-6" />
            <span className="inline-flex items-center gap-1">
              {label}
              {key === 'services' && <ServicesBadge />}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
