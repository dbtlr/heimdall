import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';

import { transitionLabel } from '../lib/conditions.ts';
import { formatClock, formatSpan, formatWhen } from '../lib/time.ts';
import { groupByRaisedDay } from '../lib/timeline-days.ts';
import type { FleetTimeline } from '../server/fleet-timeline-types.ts';
import { ConditionGlyph } from './condition-glyph.tsx';
import { InZone } from './date-time.tsx';
import { ConditionLink } from './timeline-rail.tsx';

type Entry = FleetTimeline['entries'][number];
type Transition = Entry['transitions'][number];

const LEVEL_WORD = { alert: 'Alert', note: 'Note', warning: 'Warning' } as const;

function Step({
  now,
  timeZone,
  transition,
}: {
  now: number;
  timeZone: string;
  transition: Transition;
}) {
  return (
    <span>
      {transitionLabel(transition)}
      {' · '}
      <time dateTime={new Date(transition.at).toISOString()}>
        {formatWhen(transition.at, now, timeZone)}
      </time>
      {transition.backfilled && <span className="text-muted-foreground"> · Backfilled level</span>}
    </span>
  );
}

// The transitions in the Hub's recording order, then the latest one's reason.
function Transitions({ entry, now, timeZone }: { entry: Entry; now: number; timeZone: string }) {
  const reason = entry.transitions.at(-1)?.reason ?? entry.reason;
  return (
    <>
      {entry.transitions.map((transition, index) => (
        // The Hub's recording order distinguishes transitions at the same time.
        // oxlint-disable-next-line react/no-array-index-key
        <Fragment key={index}>
          {index > 0 && ' → '}
          <Step now={now} timeZone={timeZone} transition={transition} />
        </Fragment>
      ))}
      {reason !== '' && <span className="text-muted-foreground"> · {reason}</span>}
    </>
  );
}

const CELL = 'px-2 py-2 align-top';

function Row({ entry, now, timeZone }: { entry: Entry; now: number; timeZone: string }) {
  return (
    <tr className="border-t">
      <td className={`${CELL} whitespace-nowrap tabular-nums`}>
        <time dateTime={new Date(entry.raisedAt).toISOString()}>
          {formatClock(entry.raisedAt, timeZone)}
        </time>
      </td>
      <td className={`${CELL} pt-3`}>
        <ConditionGlyph kind={entry.clearedAt === undefined ? entry.level : 'cleared'} />
        <span className="sr-only">
          {entry.clearedAt === undefined ? LEVEL_WORD[entry.level] : 'Cleared'}
        </span>
      </td>
      <td className={CELL}>
        <Link
          className="break-all text-primary"
          params={{ name: entry.system }}
          search={{ tab: 'timeline' }}
          to="/systems/$name"
        >
          {entry.system}
        </Link>
        {!entry.paired && <span className="ml-2 text-muted-foreground">Unpaired</span>}
      </td>
      <td className={CELL}>
        <ConditionLink entry={entry} system={entry.system} />
      </td>
      <td className={CELL}>
        <Transitions entry={entry} now={now} timeZone={timeZone} />
      </td>
      <td className={`${CELL} whitespace-nowrap`}>
        {entry.clearedAt === undefined ? (
          `Open for ${formatSpan(now - entry.raisedAt)}`
        ) : (
          <span className="text-muted-foreground">
            Cleared after {formatSpan(entry.clearedAt - entry.raisedAt)}
          </span>
        )}
      </td>
    </tr>
  );
}

// The table once the viewer's zone is known: a day heading row above each
// day's rows, entries in the order given.
export function TimelineTableBody({
  entries,
  now,
  timeZone,
}: {
  entries: readonly Entry[];
  now: number;
  timeZone: string;
}) {
  return (
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {['Time', 'Level', 'System', 'Condition', 'Transitions', 'Status'].map((name) => (
            <th className="px-2 pb-1" key={name} scope="col">
              {name}
            </th>
          ))}
        </tr>
      </thead>
      {groupByRaisedDay(entries, now, timeZone).map((group, index) => (
        // The same day can head two groups when entries arrive out of order.
        // oxlint-disable-next-line react/no-array-index-key
        <tbody key={`${String(index)}-${String(group.key)}`}>
          <tr>
            <th
              className="px-2 pt-5 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
              colSpan={6}
              scope="rowgroup"
            >
              {group.heading}
            </th>
          </tr>
          {group.entries.map((entry) => (
            <Row entry={entry} key={entry.id} now={now} timeZone={timeZone} />
          ))}
        </tbody>
      ))}
    </table>
  );
}

// The wide-screen Fleet Timeline: nothing until the browser's zone is known,
// as the days and times depend on it.
export function TimelineTable({ entries, now }: { entries: readonly Entry[]; now: number }) {
  return (
    <InZone>
      {(timeZone) => <TimelineTableBody entries={entries} now={now} timeZone={timeZone} />}
    </InZone>
  );
}
