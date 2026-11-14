import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { historyRows, listedRows } from '../lib/service-detail.ts';
import type { HistoryRow } from '../lib/service-detail.ts';
import { cn } from '../lib/utils.ts';
import type { ServiceDetail } from '../server/service-detail-types.ts';
import { DateTime } from './date-time.tsx';

// Installed version changes and available updates have neutral dots.
type Dot = 'bad' | 'good' | 'neutral';

const DOT: Record<Dot, string> = {
  bad: 'bg-status-critical',
  good: 'bg-status-good',
  neutral: 'bg-muted-foreground',
};

const LINE =
  'grid min-h-10 grid-cols-[8px_minmax(6.5rem,auto)_1fr_auto] items-start gap-x-2.5 py-1.5 text-left';

// A row's dot, its date and time, what happened, and how long, on one line.
function Line({
  at,
  dot,
  end,
  now,
  children,
}: {
  at: number;
  children: ReactNode;
  dot: Dot;
  end: string | undefined;
  now: number;
}) {
  return (
    <>
      <span className={cn('mt-2 size-2 rounded-full', DOT[dot])} />
      <DateTime at={at} className="font-semibold whitespace-nowrap" format="dated" now={now} />
      <span className="min-w-0 wrap-anywhere">{children}</span>
      <span className="text-sm whitespace-nowrap text-muted-foreground">{end}</span>
    </>
  );
}

// One row of the history: a Service down opens its Condition's page, and an
// installed version change or update only reads.
function HistoryItem({ now, row, system }: { now: number; row: HistoryRow; system: string }) {
  if (row.kind === 'update') {
    return (
      <div className={LINE}>
        <Line at={row.at} dot="neutral" end={undefined} now={now}>
          Update available {row.version}
        </Line>
      </div>
    );
  }
  if (row.kind === 'installed') {
    return (
      <div className={LINE}>
        <Line at={row.at} dot="neutral" end={undefined} now={now}>
          Installed {row.version}
          <span className="block text-sm text-muted-foreground">Was {row.was}</span>
        </Line>
      </div>
    );
  }
  const raised = row.kind === 'downRaised';
  return (
    <Link
      className={cn(LINE, 'rounded-md')}
      params={{ id: row.condition, name: system }}
      to="/systems/$name/conditions/$id"
    >
      <Line
        at={row.at}
        dot={raised ? 'bad' : 'good'}
        end={raised ? row.duration : undefined}
        now={now}
      >
        {raised ? 'Service down' : 'Service down cleared'}
        {raised && <span className="block text-sm text-muted-foreground">{row.reason}</span>}
      </Line>
    </Link>
  );
}

export const historyKey = (row: HistoryRow): string => {
  if (row.kind === 'update') {
    return `${row.kind}-${String(row.at)}-${row.version}`;
  }
  return row.kind === 'installed'
    ? `${row.kind}-${String(row.at)}`
    : `${row.kind}-${row.condition}`;
};

// The Service's Service down raises and clears, and installed version changes
// and available updates, newest first; the newest few show and the rest wait
// behind "Show older". Its stops are in the stops table.
export function ServiceHistory({ detail }: { detail: ServiceDetail }) {
  const { downs, installs, now, system, updates } = detail;
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(
    () => historyRows(downs, installs, updates, now),
    [downs, installs, updates, now],
  );
  const { hidden, shown } = listedRows(rows, showAll);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="mt-4">
      {shown.map((row) => (
        <HistoryItem key={historyKey(row)} now={now} row={row} system={system} />
      ))}
      {hidden > 0 && (
        <button
          className="mt-2 min-h-11 cursor-pointer text-base text-primary"
          onClick={() => {
            setShowAll(true);
          }}
          type="button"
        >
          Show {hidden} older
        </button>
      )}
    </section>
  );
}
