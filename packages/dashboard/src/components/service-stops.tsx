import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import {
  dayGroups,
  LIST_LIMIT,
  newestReceived,
  stopRows,
  stopSummary,
  stripAxis,
  stripTicks,
  WINDOW_DAYS,
} from '../lib/service-detail.ts';
import type { StopDot, StopRow } from '../lib/service-detail.ts';
import { formatDate } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { ServiceDetail } from '../server/service-detail-types.ts';
import { DateTime, InZone, PhraseText } from './date-time.tsx';

const DOT: Record<StopDot, string> = {
  bad: 'bg-status-critical',
  good: 'bg-status-good',
  unknown: 'border-[1.5px] border-muted-foreground',
};

// The count of stops, a 90-day strip with a tick for each, and how fresh the
// newest is. The Service restarted note, when open, links to its page.
export function StopsCard({ detail }: { detail: ServiceDetail }) {
  const { now, note, stops, system } = detail;
  const { last24h, total } = stopSummary(stops, now);
  const ticks = stripTicks(stops, now);
  const received = newestReceived(stops, now);
  return (
    <section className="mt-[14px] rounded-lg bg-card p-3">
      <p className="text-sm">
        <b className="font-semibold">
          {total} {total === 1 ? 'stop' : 'stops'} in {WINDOW_DAYS} days
        </b>
        <span className="text-muted-foreground"> · {last24h} in the last 24 h</span>
        {note !== undefined && (
          <>
            <span className="text-muted-foreground"> · </span>
            <Link
              className="text-primary"
              params={{ id: note.id, name: system }}
              to="/systems/$name/conditions/$id"
            >
              Service restarted note open
            </Link>
          </>
        )}
      </p>
      {total === 0 ? (
        <p className="mt-2 text-base">No stops in the {WINDOW_DAYS} days the Hub keeps.</p>
      ) : (
        <>
          <div
            aria-label={`Stops over ${WINDOW_DAYS} days`}
            className="relative mt-1.5 h-[34px] border-b"
            role="img"
          >
            {ticks.map((tick) => (
              <span
                className={cn(
                  'absolute bottom-0 w-[3px] rounded-t-sm',
                  tick.failure ? 'bg-status-serious' : 'bg-primary',
                )}
                key={tick.stoppedAt}
                style={{ height: `${tick.height}%`, left: `${tick.left}%` }}
              />
            ))}
          </div>
          <InZone>
            {(timeZone) => {
              const [from, middle] = stripAxis(now);
              return (
                <p className="mt-0.5 flex justify-between text-xs text-muted-foreground">
                  <span>{formatDate(from, timeZone)}</span>
                  <span>{formatDate(middle, timeZone)}</span>
                  <span>Today</span>
                </p>
              );
            }}
          </InZone>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Tick height grows with restarts.
            {received !== undefined && ` Newest stop received ${received}.`}
          </p>
        </>
      )}
    </section>
  );
}

// One stop on one line, and what the Hub holds of it when opened.
function StopItem({ row }: { row: StopRow }) {
  return (
    <details className="rounded-md">
      <summary className="grid min-h-10 cursor-pointer list-none grid-cols-[8px_auto_1fr_auto] items-start gap-x-2.5 py-1.5 [&::-webkit-details-marker]:hidden">
        <span className={cn('mt-2 size-2 rounded-full', DOT[row.dot])} />
        <DateTime at={row.stoppedAt} className="font-semibold whitespace-nowrap" format="clock" />
        <span className="min-w-0 wrap-anywhere">
          <PhraseText phrase={row.title} />
          {row.restarts !== undefined && (
            <span className="text-muted-foreground"> · {row.restarts}</span>
          )}
          {row.late !== undefined && (
            <span className="text-muted-foreground"> · received {row.late} late</span>
          )}
        </span>
        <span className="text-sm whitespace-nowrap text-muted-foreground">{row.duration}</span>
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

// The newest stops grouped by day in the viewer's zone, the rest behind "Show all".
export function StopList({ detail }: { detail: ServiceDetail }) {
  const { now, stops } = detail;
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => stopRows(stops, now), [stops, now]);
  const shown = showAll ? rows : rows.slice(0, LIST_LIMIT);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="mt-4">
      <InZone>
        {(timeZone) =>
          dayGroups(shown, now, timeZone).map(({ label, rows: group }) => (
            <div key={`${label}-${String(group[0]?.stoppedAt)}`}>
              <h2 className="mt-4 mb-0.5 border-t pt-2 text-xs font-normal tracking-[0.06em] text-muted-foreground uppercase">
                {label}
              </h2>
              {group.map((row) => (
                <StopItem key={row.stoppedAt} row={row} />
              ))}
            </div>
          ))
        }
      </InZone>
      {!showAll && rows.length > LIST_LIMIT && (
        <button
          className="mt-2 min-h-11 cursor-pointer text-base text-primary"
          onClick={() => {
            setShowAll(true);
          }}
          type="button"
        >
          Show all ({rows.length})
        </button>
      )}
    </section>
  );
}
