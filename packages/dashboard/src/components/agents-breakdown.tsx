import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { formatPercent, LEGEND_SHOWN } from '../lib/agents-breakdown.ts';
import type { BreakdownRow } from '../lib/agents-breakdown.ts';
import { formatCost } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { AGENTS_BREAKDOWNS } from '../server/agents-overview-types.ts';
import type { AgentsBreakdown } from '../server/agents-overview-types.ts';

export const SWITCH_LABELS: Record<AgentsBreakdown, string> = {
  harness: 'Harness',
  model: 'Model',
  project: 'Project',
  system: 'System',
};

// The segmented switch between the four ways to split the cost. Choosing one
// clears the pick, which belongs to the previous key.
export function AgentsBreakdownSwitch({ current }: { current: AgentsBreakdown }) {
  return (
    <nav aria-label="Break down by" className="flex rounded-[10px] border bg-background p-[3px]">
      {AGENTS_BREAKDOWNS.map((by) => (
        <Link
          aria-current={by === current ? 'true' : undefined}
          className={cn(
            'flex min-h-11 items-center justify-center rounded-lg px-3 text-[15px] text-muted-foreground',
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

// One key of the legend: its color, name, cost, and share. Tapping it picks
// the key, which filters the Sessions; tapping the picked key clears it.
function LegendKey({ picked, row }: { picked: boolean; row: BreakdownRow }) {
  return (
    <li>
      <Link
        aria-current={picked ? 'true' : undefined}
        className={cn(
          'flex min-h-11 max-w-full items-center gap-2 rounded-lg border px-2.5 text-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          picked && 'border-select bg-select/15',
        )}
        resetScroll={false}
        search={(previous) => ({ ...previous, pick: picked ? undefined : row.key })}
        title={row.name}
        to="."
      >
        <span
          aria-hidden="true"
          className="size-2.5 shrink-0 rounded-[3px]"
          style={{ background: row.color }}
        />
        <span className="min-w-0 truncate">{row.name}</span>
        <b
          className={cn(
            'shrink-0 font-semibold tabular-nums',
            row.pricing === 'none' && 'font-normal text-muted-foreground',
          )}
        >
          {costText(row)}
        </b>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {formatPercent(row.percent)}
        </span>
      </Link>
    </li>
  );
}

// The legend of the chart: every key with its total and share, the first five
// and a "N more" control for the rest; a picked key among them keeps it open.
// The state belongs to one split, so the caller keys the legend by it.
export function AgentsLegend({
  pick,
  rows,
}: {
  pick: string | undefined;
  rows: readonly BreakdownRow[];
}) {
  const [expanded, setExpanded] = useState(false);
  const pickedPastFold = rows.findIndex((row) => row.key === pick) >= LEGEND_SHOWN;
  const showAll = expanded || pickedPastFold;
  const hidden = rows.length - LEGEND_SHOWN;
  return (
    <div>
      <ul aria-label="Keys of the chart" className="flex flex-wrap gap-2">
        {(showAll ? rows : rows.slice(0, LEGEND_SHOWN)).map((row) => (
          <LegendKey key={row.key} picked={row.key === pick} row={row} />
        ))}
        {hidden > 0 && !pickedPastFold && (
          <li>
            <button
              aria-expanded={expanded}
              className="min-h-11 rounded-lg px-2.5 text-sm text-muted-foreground"
              onClick={() => {
                setExpanded(!expanded);
              }}
              type="button"
            >
              {expanded ? 'Show fewer' : `${String(hidden)} more`}
            </button>
          </li>
        )}
      </ul>
      {rows.some((row) => row.pricing !== 'exact') && (
        <p className="mt-2 text-sm text-muted-foreground">
          Unpriced requests may change these shares and this order.
        </p>
      )}
    </div>
  );
}
