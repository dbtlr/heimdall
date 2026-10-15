import { Link } from '@tanstack/react-router';

import { cn } from '../lib/utils.ts';
import { AGENTS_RANGES } from '../server/agents-overview-types.ts';
import type { AgentsRange } from '../server/agents-overview-types.ts';

const labels: Record<AgentsRange, string> = { '30d': '30 days', '7d': '7 days', today: 'Today' };

export function AgentsRangePicker({ current }: { current: AgentsRange }) {
  return (
    <nav
      aria-label="Agents period"
      className="inline-flex overflow-hidden rounded-lg border text-sm"
    >
      {AGENTS_RANGES.map((range) => (
        <Link
          aria-current={range === current ? 'page' : undefined}
          className={cn(
            'flex min-h-11 items-center px-4 text-muted-foreground',
            range === current && 'bg-[#2d3a5c] font-semibold text-foreground',
          )}
          key={range}
          resetScroll={false}
          search={(previous) => ({ ...previous, range })}
          to="."
        >
          {labels[range]}
        </Link>
      ))}
    </nav>
  );
}
