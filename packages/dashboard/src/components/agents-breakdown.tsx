import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { barSegments, formatPercent, VISIBLE_ROWS } from '../lib/agents-breakdown.ts';
import type { BreakdownRow } from '../lib/agents-breakdown.ts';
import { formatCost } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { AGENTS_BREAKDOWNS } from '../server/agents-overview-types.ts';
import type { AgentsBreakdown } from '../server/agents-overview-types.ts';

const SWITCH_LABELS: Record<AgentsBreakdown, string> = {
  harness: 'Harness',
  model: 'Model',
  project: 'Project',
  system: 'System',
};

// How the bar's label names the dimension, in running text.
const BAR_LABELS: Record<AgentsBreakdown, string> = {
  harness: 'Harness',
  model: 'model',
  project: 'project',
  system: 'System',
};

// The segmented switch between the four ways to break the cost down. Choosing
// one clears the pick, which belongs to the previous dimension.
export function AgentsBreakdownSwitch({ current }: { current: AgentsBreakdown }) {
  return (
    <nav
      aria-label="Break down by"
      className="mt-4 flex rounded-[10px] border bg-background p-[3px]"
    >
      {AGENTS_BREAKDOWNS.map((by) => (
        <Link
          aria-current={by === current ? 'true' : undefined}
          className={cn(
            'flex min-h-11 flex-1 items-center justify-center rounded-lg px-1 text-[15px] text-muted-foreground',
            by === current && 'bg-accent font-semibold text-foreground',
          )}
          key={by}
          replace
          resetScroll={false}
          search={(previous) => ({ ...previous, by, pick: undefined })}
          to="."
        >
          {SWITCH_LABELS[by]}
        </Link>
      ))}
    </nav>
  );
}

const costText = (row: BreakdownRow) => {
  if (row.pricing === 'none') {
    return 'No list price';
  }
  return `${row.pricing === 'at-least' ? 'At least ' : ''}${formatCost(row.pricedCostUsd)}`;
};

function BreakdownItem({ picked, row }: { picked: boolean; row: BreakdownRow }) {
  return (
    <li>
      <Link
        aria-current={picked ? 'true' : undefined}
        className={cn(
          '-mx-2 flex min-h-11 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          picked && 'bg-accent outline-1 outline-chart-1',
        )}
        resetScroll={false}
        search={(previous) => ({ ...previous, pick: picked ? undefined : row.key })}
        title={row.name}
        to="."
      >
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: row.color }}
        />
        <span className="min-w-0 flex-1 break-words">{row.name}</span>
        <span className="w-10 shrink-0 text-right text-sm text-muted-foreground tabular-nums">
          {formatPercent(row.percent)}
        </span>
        <b
          className={cn(
            'max-w-[45%] shrink-0 text-right font-semibold tabular-nums',
            row.pricing === 'none' && 'text-sm font-normal text-muted-foreground',
          )}
        >
          {costText(row)}
        </b>
      </Link>
    </li>
  );
}

// The stacked bar and the ranked list of one dimension. Rows past the eighth
// fold into a "N more" control; a picked row among them opens the list.
export function AgentsBreakdownList({
  by,
  pick,
  rows,
}: {
  by: AgentsBreakdown;
  pick: string | undefined;
  rows: BreakdownRow[];
}) {
  const [expanded, setExpanded] = useState(
    rows.findIndex((row) => row.key === pick) >= VISIBLE_ROWS,
  );
  const hidden = rows.length - VISIBLE_ROWS;
  return (
    <>
      <div
        aria-label={`Priced request cost by ${BAR_LABELS[by]}`}
        className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-full bg-accent"
        role="img"
      >
        {barSegments(rows).map((segment) => (
          <span
            key={segment.key}
            style={{ background: segment.color, width: `${String(segment.percent)}%` }}
          />
        ))}
      </div>
      <ul className="mt-2">
        {(expanded ? rows : rows.slice(0, VISIBLE_ROWS)).map((row) => (
          <BreakdownItem key={row.key} picked={row.key === pick} row={row} />
        ))}
      </ul>
      {hidden > 0 && (
        <button
          aria-expanded={expanded}
          className="min-h-11 text-sm text-muted-foreground"
          onClick={() => {
            setExpanded(!expanded);
          }}
          type="button"
        >
          {expanded ? 'Show fewer' : `${String(hidden)} more`}
        </button>
      )}
    </>
  );
}
