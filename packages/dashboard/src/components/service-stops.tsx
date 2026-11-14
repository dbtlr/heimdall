import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import {
  availability,
  percentWords,
  stripWindow,
  WINDOW_DAYS,
} from '../lib/service-availability.ts';
import type { DayState } from '../lib/service-availability.ts';
import { HISTORY_LIMIT, listedRows, stopLines } from '../lib/service-detail.ts';
import { formatDate } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { ServiceDetail } from '../server/service-detail-types.ts';
import { DateTime, InZone, PhraseText } from './date-time.tsx';

// A day's cell: the Hub's status colors for up, restarted, and down, and a
// neutral one for a day the System sent no Vitals.
const CELL: Record<DayState, string> = {
  down: 'bg-status-critical',
  quiet: 'bg-muted',
  restarted: 'bg-status-warning',
  up: 'bg-status-good',
};

const STATE_WORDS: Record<DayState, string> = {
  down: 'down',
  quiet: 'no Reports',
  restarted: 'restarted',
  up: 'up',
};

// The phone shows this many of the strip's days.
const PHONE_DAYS = 30;

// The 90 days as one cell each, the share of the time the Service was up, and
// the count of down periods and restarts. The phone shows the last 30 days. The
// Service restarted note, when open, links to its page.
export function AvailabilityCard({ detail }: { detail: ServiceDetail }) {
  const { downs, now, note, reportDays, stops, system } = detail;
  const found = useMemo(
    () => availability({ downs, now, reportDays, stops }),
    [downs, now, reportDays, stops],
  );
  const percent = percentWords(found.percent);
  const { from } = stripWindow(now);
  return (
    <section className="mt-[14px] card-surface rounded-xl border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <h2 className="font-semibold">Availability · {WINDOW_DAYS} days</h2>
        <p>
          {percent !== undefined && <b className="font-semibold tabular-nums">{percent} </b>}
          <span className="text-muted-foreground">
            {found.downPeriods} down {found.downPeriods === 1 ? 'period' : 'periods'},{' '}
            {found.restarts} {found.restarts === 1 ? 'restart' : 'restarts'}
          </span>
        </p>
      </div>
      <InZone>
        {(timeZone) => (
          <div
            aria-label={`Availability over ${String(WINDOW_DAYS)} days`}
            className="mt-2 flex h-[26px] gap-px"
            role="img"
          >
            {found.days.map((day, index) => (
              <span
                className={cn(
                  'min-w-0 flex-1 rounded-[2px]',
                  CELL[day.state],
                  index < WINDOW_DAYS - PHONE_DAYS && 'max-sm:hidden',
                )}
                key={day.from}
                title={`${formatDate(day.from, timeZone)}: ${STATE_WORDS[day.state]}`}
              />
            ))}
          </div>
        )}
      </InZone>
      <InZone>
        {(timeZone) => (
          <p className="mt-0.5 flex justify-between text-xs text-muted-foreground">
            <span className="max-sm:hidden">{formatDate(from, timeZone)}</span>
            <span className="sm:hidden">
              {formatDate(from + (WINDOW_DAYS - PHONE_DAYS) * 86_400_000, timeZone)}
            </span>
            <span className="max-sm:hidden">
              {formatDate(from + (WINDOW_DAYS / 2) * 86_400_000, timeZone)}
            </span>
            <span>Today</span>
          </p>
        )}
      </InZone>
      <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {(['up', 'restarted', 'down', 'quiet'] as const).map((state) => (
          <span className="flex items-center gap-1.5" key={state}>
            <span className={cn('size-2.5 rounded-[2px]', CELL[state])} />
            {STATE_WORDS[state]}
          </span>
        ))}
      </p>
      <p className="mt-1 text-xs text-muted-foreground sm:hidden">
        Shows the last {PHONE_DAYS} days; the percentage covers {WINDOW_DAYS}.
      </p>
      {note !== undefined && (
        <p className="mt-2 text-sm">
          <Link
            className="text-primary"
            params={{ id: note.id, name: system }}
            to="/systems/$name/conditions/$id"
          >
            Service restarted note open
          </Link>
        </p>
      )}
    </section>
  );
}

const CHIP = 'rounded-full border px-2 text-sm font-semibold whitespace-nowrap tabular-nums';

// The stops of the 90 days, newest first, each a link that selects it for the
// Vitals window by the URL. The newest few show and the rest wait behind
// "Show older", unless the selected one is among them.
export function StopsTable({ detail }: { detail: ServiceDetail }) {
  const { downs, now, selection, service, stops, system } = detail;
  const lines = useMemo(() => stopLines(stops, downs, now), [stops, downs, now]);
  const selectedAt = selection?.span.from;
  const [showAll, setShowAll] = useState(
    lines.findIndex((line) => line.stoppedAt === selectedAt) >= HISTORY_LIMIT,
  );
  const { hidden, shown } = listedRows(lines, showAll);
  return (
    <section className="card-surface min-w-0 rounded-xl border p-3">
      <h2 className="text-sm font-semibold">Stops · last {WINDOW_DAYS} days</h2>
      {lines.length === 0 ? (
        <p className="mt-2 text-base">No stops in the {WINDOW_DAYS} days the Hub keeps.</p>
      ) : (
        <ul className="mt-1.5">
          {shown.map((line) => {
            const selected = line.stoppedAt === selectedAt;
            return (
              <li key={line.stoppedAt}>
                <Link
                  aria-current={selected ? 'true' : undefined}
                  className={cn(
                    'flex min-h-11 flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border border-transparent px-2 py-1.5',
                    selected && 'border-select/50 bg-select/10',
                  )}
                  params={{ name: system, service }}
                  resetScroll={false}
                  search={{ stop: line.stoppedAt }}
                  to="/systems/$name/services/$service"
                >
                  <DateTime
                    at={line.stoppedAt}
                    className="font-semibold whitespace-nowrap"
                    format="dated"
                    now={now}
                  />
                  <span
                    className={cn(
                      CHIP,
                      line.down
                        ? 'border-status-critical/60 text-status-critical'
                        : 'border-status-warning/60 text-status-warning',
                    )}
                  >
                    {line.down ? 'Down' : 'Restarted'} · {line.duration}
                  </span>
                  <span className="min-w-0 text-sm text-muted-foreground wrap-anywhere">
                    <PhraseText phrase={line.result} />
                    {line.restarts > 0 && (
                      <>
                        {' '}
                        · {line.restarts} {line.restarts === 1 ? 'restart' : 'restarts'}
                      </>
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {hidden > 0 && (
        <button
          className="mt-1 min-h-11 cursor-pointer text-base text-primary"
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
