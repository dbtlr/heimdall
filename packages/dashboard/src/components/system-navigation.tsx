import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { statusWord } from '../lib/lane.ts';
import { contentFrame } from '../lib/layout.ts';
import { SYSTEM_TABS } from '../lib/system-search.ts';
import type { SystemTab } from '../lib/system-search.ts';
import { cn } from '../lib/utils.ts';
import type { Range } from '../server/fleet-overview-types.ts';
import type { SystemNavigation } from '../server/system-navigation.ts';
import { MARK_COLOR } from './attention-status.tsx';

const TAB_NAMES: Record<SystemTab, string> = {
  now: 'Now',
  records: 'Records',
  sessions: 'Sessions',
  timeline: 'Timeline',
  vitals: 'Vitals',
};

const statusLabel = (system: SystemNavigation[number]) => {
  if (system.status === 'unpaired') {
    return 'Unpaired';
  }
  if (system.level === 'alert') {
    return 'Alert';
  }
  if (system.level === 'warning') {
    return 'Warning';
  }
  return statusWord(system.status);
};

const statusColor = (system: SystemNavigation[number]) => {
  if (system.status === 'unpaired') {
    return 'text-muted-foreground';
  }
  if (system.level !== undefined) {
    return MARK_COLOR[system.level];
  }
  return system.status === 'up' ? 'text-[#7fdcae]' : 'text-muted-foreground';
};

// The System's local navigation stays visible; switching peers drops its sample.
export function SystemNavigationHeader({
  current,
  range,
  systems,
  tab,
}: {
  current: string;
  range: Range;
  systems: SystemNavigation;
  tab: SystemTab;
}) {
  const selected = systems.find((system) => system.name === current);
  const activePill = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    activePill.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [current]);
  return (
    <header className="sticky top-0 z-20 border-b bg-card pt-[env(safe-area-inset-top)] sm:bg-background">
      <div className={contentFrame('wide')}>
        <div className="flex min-h-14 items-center gap-3">
          <Link
            className="flex min-h-11 shrink-0 items-center text-base text-muted-foreground lg:hidden"
            to="/"
          >
            ‹ Fleet
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-[22px] font-semibold" title={current}>
            {current}
          </h1>
          {selected !== undefined && (
            <span
              className={cn(
                'shrink-0 rounded-full bg-card px-2.5 py-1 text-sm font-semibold',
                statusColor(selected),
              )}
            >
              {statusLabel(selected)}
            </span>
          )}
        </div>
        <nav
          aria-label="Systems"
          className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:thin] lg:hidden"
        >
          {systems.map((system) => (
            <Link
              aria-current={system.name === current ? 'page' : undefined}
              aria-label={`${system.name}: ${statusLabel(system)}`}
              className={cn(
                'flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-base',
                system.name === current
                  ? 'border-foreground bg-foreground text-background'
                  : 'bg-card',
              )}
              hash=""
              key={system.name}
              params={{ name: system.name }}
              ref={system.name === current ? activePill : undefined}
              search={{ range, tab }}
              to="/systems/$name"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-2.5 rounded-full',
                  statusColor(system),
                  system.status === 'up' || system.level !== undefined
                    ? 'bg-current'
                    : 'border-2 border-current',
                  system.status === 'unpaired' && 'border-2 border-dashed bg-transparent',
                )}
              />
              {system.name}
            </Link>
          ))}
        </nav>
        <nav
          aria-label="System views"
          className="flex justify-between gap-1 overflow-x-auto lg:justify-start lg:gap-6"
        >
          {SYSTEM_TABS.map((item) => (
            <Link
              aria-current={tab === item ? 'page' : undefined}
              className={cn(
                'flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-1.5 text-base text-muted-foreground sm:px-4',
                tab === item && 'border-foreground font-semibold text-foreground',
              )}
              from="/systems/$name"
              hash=""
              key={item}
              resetScroll
              search={(previous) => ({ ...previous, tab: item })}
              to="."
            >
              {TAB_NAMES[item]}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
