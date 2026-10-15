import { Link } from '@tanstack/react-router';

import { RANGE_LABELS } from '../lib/range.ts';
import { cn } from '../lib/utils.ts';
import { RANGES } from '../server/fleet-overview-types.ts';
import type { Range } from '../server/fleet-overview-types.ts';

// The segmented control that picks how far back the page looks. The range
// lives in the URL, so a link to a range shares it.
export function RangePicker({ current }: { current: Range }) {
  return (
    <nav
      aria-label="Range"
      className="ml-auto inline-flex overflow-hidden rounded-md border text-[13px]"
    >
      {RANGES.map((range) => (
        <Link
          aria-current={range === current ? 'page' : undefined}
          className={cn(
            'flex min-h-11 items-center px-[11px] py-1 text-muted-foreground',
            range === current && 'bg-[#2d3a5c] text-foreground',
          )}
          key={range}
          resetScroll={false}
          search={(previous) => ({ ...previous, range })}
          to="."
        >
          {RANGE_LABELS[range]}
        </Link>
      ))}
    </nav>
  );
}
