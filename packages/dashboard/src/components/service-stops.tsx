import { Link } from '@tanstack/react-router';

import {
  newestReceived,
  stopSummary,
  stripAxis,
  stripTicks,
  WINDOW_DAYS,
} from '../lib/service-detail.ts';
import { formatDate } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { ServiceDetail } from '../server/service-detail-types.ts';
import { InZone } from './date-time.tsx';

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
