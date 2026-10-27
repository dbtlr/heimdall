import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import { historyRows, listedRows } from '../lib/service-detail.ts';
import type { HistoryRow, StopDot, StopRow } from '../lib/service-detail.ts';
import { cn } from '../lib/utils.ts';
import type { ServiceDetail } from '../server/service-detail-types.ts';
import { DateTime, PhraseText } from './date-time.tsx';

// An installed version change is neither good nor bad, so its dot is neutral.
type Dot = StopDot | 'neutral';

const DOT: Record<Dot, string> = {
  bad: 'bg-status-critical',
  good: 'bg-status-good',
  neutral: 'bg-muted-foreground',
  unknown: 'border-[1.5px] border-muted-foreground',
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

// One stop on one line, and what the Hub holds of it when opened.
function StopItem({ now, row }: { now: number; row: StopRow }) {
  return (
    <details className="rounded-md">
      <summary className={cn(LINE, 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')}>
        <Line at={row.stoppedAt} dot={row.dot} end={row.duration} now={now}>
          <PhraseText phrase={row.title} />
          {row.restarts !== undefined && (
            <span className="text-muted-foreground"> · {row.restarts}</span>
          )}
          {row.late !== undefined && (
            <span className="text-muted-foreground"> · received {row.late} late</span>
          )}
        </Line>
      </summary>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pr-0 pb-2 pl-[18px] text-sm">
        {row.details.map(({ label, value }) => (
          <div className="contents" key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 wrap-anywhere">
              <PhraseText phrase={value} />
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// One row of the history: a stop opens in place, a Service down opens its
// Condition's page, and an installed version change only reads.
function HistoryItem({ now, row, system }: { now: number; row: HistoryRow; system: string }) {
  if (row.kind === 'stop') {
    return <StopItem now={now} row={row.stop} />;
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

// The Service's stops, Service down raises and clears, and installed version
// changes, newest first; the newest few show and the rest wait behind "Show older".
export function ServiceHistory({ detail }: { detail: ServiceDetail }) {
  const { downs, installs, now, stops, system } = detail;
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(
    () => historyRows(stops, downs, installs, now),
    [stops, downs, installs, now],
  );
  const { hidden, shown } = listedRows(rows, showAll);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="mt-4">
      {shown.map((row) => (
        <HistoryItem
          key={
            row.kind === 'stop' || row.kind === 'installed'
              ? `${row.kind}-${String(row.at)}`
              : `${row.kind}-${row.condition}`
          }
          now={now}
          row={row}
          system={system}
        />
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
