import { Link } from '@tanstack/react-router';

import { RANGE_LABELS } from '../lib/range.ts';
import { cn } from '../lib/utils.ts';
import { isLongRange, RANGES } from '../server/fleet-overview-types.ts';
import type { Range } from '../server/fleet-overview-types.ts';

// The two kinds of range, each its own segment: up to 7 d the charts and the
// inspector read 5-minute samples; 30 d and 1 y read rollups, and the
// inspector a bucket.
const GROUPS = [
  { label: '5-minute samples', ranges: RANGES.filter((range) => !isLongRange(range)) },
  { label: 'rollups', ranges: RANGES.filter((range) => isLongRange(range)) },
];

// The segmented control that picks how far back the page looks. The range
// lives in the URL, so a link to a range shares it. From 1024 px up each
// segment is named.
export function RangePicker({ current }: { current: Range }) {
  return (
    <nav aria-label="Range" className="ml-auto flex items-center gap-2 text-[13px]">
      {GROUPS.map((group) => (
        <div className="flex items-center gap-2" key={group.label}>
          <span className="hidden text-[11px] text-dim lg:inline">{group.label}</span>
          <div className="inline-flex overflow-hidden rounded-md border">
            {group.ranges.map((range) => (
              <Link
                aria-current={range === current ? 'page' : undefined}
                className={cn(
                  'flex min-h-11 items-center px-[11px] py-1 text-muted-foreground',
                  range === current && 'bg-secondary text-foreground',
                )}
                key={range}
                resetScroll={false}
                search={(previous) => ({ ...previous, range })}
                to="."
              >
                {RANGE_LABELS[range]}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
