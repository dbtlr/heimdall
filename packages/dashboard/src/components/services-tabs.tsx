import { Link } from '@tanstack/react-router';

import { cn } from '../lib/utils.ts';

const TAB = 'flex min-h-9 items-center rounded-lg px-3 text-[15px] text-muted-foreground';

// The sub-tabs of the Services section: its Services and its jobs.
export function ServicesTabs() {
  return (
    <nav aria-label="Services section" className="flex gap-1 pt-4">
      {(
        [
          ['/services', 'Services'],
          ['/jobs', 'Jobs'],
        ] as const
      ).map(([to, label]) => (
        <Link
          activeOptions={{ exact: true }}
          activeProps={{
            'aria-current': 'page',
            className: cn(TAB, 'bg-secondary font-semibold text-foreground'),
          }}
          className={cn(TAB, 'hover:text-foreground')}
          key={to}
          to={to}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
