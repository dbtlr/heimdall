import { Link } from '@tanstack/react-router';

import { TABS } from '../lib/session-search.ts';
import type { Tab } from '../lib/session-search.ts';
import { cn } from '../lib/utils.ts';

const TAB_NAMES: Record<Tab, string> = { cost: 'Cost', timeline: 'Timeline', trace: 'Trace' };

// The Session page's tabs; the open one is in the URL, and the selection
// carries across them.
export function SessionTabs({ current }: { current: Tab }) {
  return (
    <nav aria-label="Session views" className="mt-4 mb-3.5 flex border-b">
      {TABS.map((tab) => (
        <Link
          aria-current={tab === current ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 border-transparent px-3.5 py-2 text-[15px] font-medium text-muted-foreground',
            tab === current && 'border-b-[#ffd666] text-foreground',
          )}
          from="/systems/$name/sessions/$harness/$source/$sessionId"
          key={tab}
          search={(previous) => ({ ...previous, tab })}
          to="."
        >
          {TAB_NAMES[tab]}
        </Link>
      ))}
    </nav>
  );
}
