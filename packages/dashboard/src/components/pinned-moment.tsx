import { Link } from '@tanstack/react-router';

import { changesNear, sessionsSummary } from '../lib/activity-moment.ts';
import { groupActivity, lineWords } from '../lib/activity.ts';
import { harnessColor, harnessName } from '../lib/lane.ts';
import { rangeHolding } from '../lib/system-search.ts';
import { formatClock, formatCost, formatDated, formatSpan } from '../lib/time.ts';
import type { ActivityEvent } from '../server/activity-types.ts';
import type { MomentSession, MomentVitals, PinnedMoment } from '../server/pinned-moment-types.ts';
import type { Pin } from './activity-list.tsx';
import { InZone } from './date-time.tsx';

// What the page knows of the pinned moment's read: still coming, failed, or in.
export type MomentRead =
  | { state: 'failed' }
  | { moment: PinnedMoment; state: 'ready' }
  | { state: 'loading' };

const HEADING = 'mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-dim uppercase';

// The pinned moment's sessions as lines: Harness bar, project and System, and
// the cost and length of the whole Session, first request to latest.
function SessionRows({ sessions }: { sessions: readonly MomentSession[] }) {
  return (
    <ul className="space-y-1.5 text-sm">
      {sessions.map((session) => (
        <li key={`${session.system}-${session.source}-${session.sessionId}`}>
          <Link
            className="flex flex-wrap items-baseline gap-x-2 text-foreground hover:underline"
            params={{
              harness: session.harness,
              name: session.system,
              sessionId: session.sessionId,
              source: session.source,
            }}
            to="/systems/$name/sessions/$harness/$source/$sessionId"
          >
            <i
              aria-hidden="true"
              className="inline-block h-2 w-3.5 flex-none self-center rounded-[2px]"
              style={{ backgroundColor: harnessColor(session.harness) }}
            />
            <span>{harnessName(session.harness)}</span>
            {session.project !== undefined && <b className="font-semibold">{session.project}</b>}
            <span className="text-muted-foreground">on {session.system}</span>
          </Link>
          <p className="pl-[22px] text-[13px] text-muted-foreground tabular-nums">
            {formatCost(session.costUsd)} · {formatSpan(session.endedAt - session.startedAt)} in all
          </p>
        </li>
      ))}
    </ul>
  );
}

const percent = (value: number | undefined) =>
  value === undefined ? 'unknown' : `${String(Math.round(value))}%`;

// The link to the System page at the sample, on the shortest range whose
// charts hold it.
function SampleLink({
  className,
  now,
  system,
  vitals,
}: {
  className: string;
  now: number;
  system: string;
  vitals: MomentVitals;
}) {
  return (
    <Link
      className={className}
      params={{ name: system }}
      search={{ at: vitals.t, range: rangeHolding(vitals.t, now), tab: 'vitals' }}
      to="/systems/$name"
    >
      Open {system} at this moment →
    </Link>
  );
}

// The System's CPU, memory, and load at the moment, with a link to the System
// page at that sample.
function VitalsColumn({
  now,
  system,
  timeZone,
  vitals,
}: {
  now: number;
  system: string;
  timeZone: string;
  vitals: MomentVitals | undefined;
}) {
  if (vitals === undefined) {
    return <p className="text-sm text-muted-foreground">No Vitals near this moment.</p>;
  }
  return (
    <>
      <p className="text-sm tabular-nums">
        CPU <b className="font-semibold">{percent(vitals.cpu)}</b> · memory{' '}
        <b className="font-semibold">{percent(vitals.memory)}</b> · load{' '}
        <b className="font-semibold">
          {vitals.load === undefined ? 'unknown' : vitals.load.toFixed(1)}
        </b>
      </p>
      <p className="text-[13px] text-muted-foreground">
        Sample at {formatClock(vitals.t, timeZone)}
      </p>
      <SampleLink
        className="mt-1 inline-flex min-h-11 items-center text-sm text-primary"
        now={now}
        system={system}
        vitals={vitals}
      />
    </>
  );
}

function ChangesColumn({ events, pin }: { events: readonly ActivityEvent[]; pin: Pin }) {
  const lines = groupActivity(changesNear(events, pin));
  if (lines.length === 0) {
    return <p className="text-sm text-muted-foreground">No change within 15 minutes.</p>;
  }
  return (
    <ul className="space-y-1.5 text-sm">
      {lines.map((line) => {
        const words = lineWords(line);
        return (
          <li key={`${line.system}-${String(line.at)}`}>
            <b className="font-semibold">{words.title}</b>
            {words.subject !== '' && (
              <span className="ml-1.5 font-mono text-[13px]">{words.subject}</span>
            )}
            <span className="ml-1.5 text-muted-foreground">on {line.system}</span>
            {words.alert !== undefined && (
              <p className="text-[13px] text-muted-foreground">
                Alert pushed at <InZone>{(zone) => formatClock(words.alert?.at ?? 0, zone)}</InZone>
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// What the pinned card holds once the viewer's zone is known: its heading, and
// the read's state or its columns. From `sm` three columns, the changes within
// 15 minutes, the Sessions running with their cost, and one System's Vitals; a
// phone gets the summary and the link.
export function PinnedMomentBody({
  events,
  now,
  onClear,
  pin,
  read,
  timeZone,
}: {
  events: readonly ActivityEvent[];
  now: number;
  onClear: () => void;
  pin: Pin;
  read: MomentRead;
  timeZone: string;
}) {
  const lines = groupActivity(changesNear(events, pin));
  return (
    <>
      <header className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-sm font-semibold">Pinned · {formatDated(pin.at, now, timeZone)}</h2>
        <span className="hidden text-[13px] text-dim sm:inline">
          drag the line or pick a change
        </span>
        <button
          className="ml-auto inline-flex min-h-11 items-center text-sm text-primary"
          onClick={onClear}
          type="button"
        >
          Clear
        </button>
      </header>
      {read.state === 'loading' && (
        <p aria-live="polite" className="text-sm text-muted-foreground">
          Reading the Sessions…
        </p>
      )}
      {read.state === 'failed' && (
        <p className="text-sm text-status-critical">Could not read this moment.</p>
      )}
      {read.state === 'ready' && (
        <>
          <div className="hidden gap-x-8 sm:grid sm:grid-cols-3">
            <div>
              <h3 className={HEADING}>Changes within 15 min</h3>
              <ChangesColumn events={events} pin={pin} />
            </div>
            <div>
              <h3 className={HEADING}>{sessionsSummary(read.moment.sessions)}</h3>
              <SessionRows sessions={read.moment.sessions} />
            </div>
            {pin.system !== undefined && (
              <div>
                <h3 className={HEADING}>
                  {pin.system} at {formatClock(pin.at, timeZone)}
                </h3>
                <VitalsColumn
                  now={now}
                  system={pin.system}
                  timeZone={timeZone}
                  vitals={read.moment.vitals}
                />
              </div>
            )}
          </div>
          <div className="text-sm sm:hidden">
            {lines[0] !== undefined && (
              <p>
                <b className="font-semibold">{lineWords(lines[0]).title}</b>{' '}
                <span className="text-muted-foreground">on {lines[0].system}</span>
              </p>
            )}
            <p className="text-muted-foreground">{sessionsSummary(read.moment.sessions)}</p>
            {pin.system !== undefined && read.moment.vitals !== undefined && (
              <SampleLink
                className="inline-flex min-h-11 items-center text-primary"
                now={now}
                system={pin.system}
                vitals={read.moment.vitals}
              />
            )}
          </div>
        </>
      )}
    </>
  );
}

// The card under the axis: what the pinned moment holds, or with no pin, how to
// set one.
export function PinnedMomentCard({
  events,
  now,
  onClear,
  pin,
  read,
}: {
  events: readonly ActivityEvent[];
  now: number;
  onClear: () => void;
  pin: Pin | undefined;
  read: MomentRead;
}) {
  if (pin === undefined) {
    return (
      <section
        aria-label="Pinned moment"
        className="card-surface mt-3 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground"
      >
        Drag across a lane, or pick a change in the list, to pin a moment and see the Sessions
        running then.
      </section>
    );
  }
  return (
    <section
      aria-label="Pinned moment"
      className="card-surface mt-3 rounded-xl border border-select/60 px-4 py-3"
    >
      <InZone>
        {(timeZone) => (
          <PinnedMomentBody
            events={events}
            now={now}
            onClear={onClear}
            pin={pin}
            read={read}
            timeZone={timeZone}
          />
        )}
      </InZone>
    </section>
  );
}
