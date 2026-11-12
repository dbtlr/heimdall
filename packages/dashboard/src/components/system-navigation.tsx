import { Link } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { statusWord } from '../lib/lane.ts';
import { contentFrame } from '../lib/layout.ts';
import { DESKTOP_TABS, desktopTab, SYSTEM_TABS } from '../lib/system-search.ts';
import type { SystemTab } from '../lib/system-search.ts';
import { cn } from '../lib/utils.ts';
import type { Range } from '../server/fleet-overview-types.ts';
import type { SystemNavigation } from '../server/system-navigation.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { RangePicker } from './range-picker.tsx';

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
  return system.status === 'up' ? 'text-status-good' : 'text-muted-foreground';
};

// The System's local navigation stays visible: its name and status, a chip for
// each System to switch to, and its tabs. Switching Systems keeps the tab and
// range and drops the sample.
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
    // Under the top bar, it sticks below the strip that paints the status area.
    <header className="sticky top-[max(6px,env(safe-area-inset-top))] z-20 border-b bg-bar sm:bg-background sm:pointer-fine:top-[env(safe-area-inset-top)]">
      <div className={contentFrame('wide')}>
        <div className="flex min-h-14 items-center gap-3">
          <Link
            className="flex min-h-11 shrink-0 items-center text-base text-muted-foreground lg:hidden"
            to="/systems"
          >
            ‹ Systems
          </Link>
          <h1 className="min-w-0 flex-1 truncate text-[22px] font-semibold" title={current}>
            {current}
          </h1>
          {selected !== undefined && (
            <span
              className={cn(
                'shrink-0 rounded-full bg-secondary px-2.5 py-1 text-sm font-semibold',
                statusColor(selected),
              )}
            >
              {statusLabel(selected)}
            </span>
          )}
        </div>
        <nav
          aria-label="Systems"
          className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:thin] lg:gap-1.5"
        >
          {systems.map((system) => (
            <Link
              aria-current={system.name === current ? 'page' : undefined}
              aria-label={`${system.name}: ${statusLabel(system)}`}
              className={cn(
                'flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-base lg:min-h-8 lg:gap-1.5 lg:px-2.5 lg:text-sm',
                system.name === current
                  ? 'border-foreground bg-foreground text-background'
                  : 'bg-secondary',
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
        <div className="hidden items-center justify-between gap-4 lg:flex">
          <nav aria-label="System views" className="flex gap-6">
            {DESKTOP_TABS.map((item) => (
              <Link
                aria-current={desktopTab(tab) === desktopTab(item.tab) ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-1.5 text-base text-muted-foreground sm:px-4',
                  desktopTab(tab) === desktopTab(item.tab) &&
                    'border-select font-semibold text-foreground',
                )}
                from="/systems/$name"
                hash=""
                key={item.name}
                resetScroll
                search={(previous) => ({ ...previous, tab: item.tab })}
                to="."
              >
                {item.name}
              </Link>
            ))}
          </nav>
          <RangePicker current={range} />
        </div>
        <nav
          aria-label="System views"
          className="flex justify-between gap-1 overflow-x-auto lg:hidden"
        >
          {SYSTEM_TABS.map((item) => (
            <Link
              aria-current={tab === item ? 'page' : undefined}
              className={cn(
                'flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-1.5 text-base text-muted-foreground sm:px-4',
                tab === item && 'border-select font-semibold text-foreground',
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
