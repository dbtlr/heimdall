import { Link } from '@tanstack/react-router';

import { groupByDay } from '../lib/activity-days.ts';
import { lineWords } from '../lib/activity.ts';
import type { ActivityLine } from '../lib/activity.ts';
import { formatClock } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { ActivityEvent } from '../server/activity-types.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { InZone } from './date-time.tsx';

// The moment pinned on the axis: its time and the System it was pinned on.
export type Pin = { at: number; system: string | undefined };

const LEVEL_WORD = { alert: 'Alert', note: 'Note', warning: 'Warning' } as const;

const MARKER = 'rounded-full border px-2 text-xs whitespace-nowrap';

// The mark for a line's lead change: a Condition's level glyph, and for the
// kinds without a level a neutral shape, so a color keeps one meaning: a
// square for a version change, a ring for a Service stop, and a dot for an
// alert sent. Drift takes its Condition's level glyph, and a Condition or
// Drift that cleared takes the cleared ring.
export function KindGlyph({
  event,
  words,
}: {
  event: ActivityEvent;
  words: ReturnType<typeof lineWords>;
}) {
  if (words.level !== undefined) {
    return (
      <ConditionGlyph
        kind={
          (event.kind === 'condition' || event.kind === 'drift') && event.action === 'cleared'
            ? 'cleared'
            : words.level
        }
      />
    );
  }
  return (
    <svg aria-hidden="true" className="size-[11px] flex-none fill-plot" viewBox="0 0 12 12">
      {event.kind === 'version' && <rect height="9" width="9" x="1.5" y="1.5" />}
      {event.kind === 'stop' && (
        <circle className="fill-none stroke-plot stroke-[1.8]" cx="6" cy="6" r="4.2" />
      )}
      {event.kind === 'alert' && <circle cx="6" cy="6" r="4.5" />}
    </svg>
  );
}

// Where a line's lead change leads: a Condition to its page, a Service change
// to the Service's page, nothing for an alert alone.
function Title({ line, words }: { line: ActivityLine; words: ReturnType<typeof lineWords> }) {
  const [lead] = line.events;
  const text = (
    <>
      <b className="font-semibold">{words.title}</b>
      {words.subject !== '' && (
        <span className="ml-1.5 font-mono text-[13px] break-all">{words.subject}</span>
      )}
      {words.change !== '' && <span className="ml-1.5">{words.change}</span>}
    </>
  );
  if (lead?.kind === 'condition' || lead?.kind === 'drift') {
    return (
      <Link
        className="text-foreground hover:underline"
        params={{ id: lead.conditionId, name: line.system }}
        to="/systems/$name/conditions/$id"
      >
        {text}
      </Link>
    );
  }
  if (lead?.kind === 'stop' || lead?.kind === 'version') {
    return (
      <Link
        className="text-foreground hover:underline"
        params={{ name: line.system, service: lead.service }}
        to="/systems/$name/services/$service"
      >
        {text}
      </Link>
    );
  }
  return <span>{text}</span>;
}

// Whether the viewer has pinned `line`'s moment on the axis.
const isPinned = (line: ActivityLine, pinned: Pin | undefined) =>
  pinned !== undefined && pinned.at === line.at && pinned.system === line.system;

function Line({
  line,
  onPick,
  pinned,
  timeZone,
  unpaired,
}: {
  line: ActivityLine;
  onPick: ((line: ActivityLine) => void) | undefined;
  pinned: boolean;
  timeZone: string;
  unpaired: boolean;
}) {
  const words = lineWords(line);
  const [lead] = line.events;
  if (lead === undefined) {
    return null;
  }
  return (
    <li
      className={cn(
        'grid grid-cols-[3rem_1rem_minmax(0,1fr)] gap-x-2.5 border-t py-2.5 first:border-t-0',
        pinned && '-mx-2 rounded-md border-l-2 border-l-select bg-select/15 px-2',
      )}
    >
      {onPick === undefined ? (
        <time
          className="pt-px text-[13px] text-dim tabular-nums"
          dateTime={new Date(line.at).toISOString()}
        >
          {formatClock(line.at, timeZone)}
        </time>
      ) : (
        <button
          aria-label={`Pin ${formatClock(line.at, timeZone)} on the axis`}
          aria-pressed={pinned}
          className="self-start pt-px text-left text-[13px] text-dim tabular-nums hover:text-foreground"
          onClick={() => {
            onPick(line);
          }}
          type="button"
        >
          <time dateTime={new Date(line.at).toISOString()}>{formatClock(line.at, timeZone)}</time>
        </button>
      )}
      <span className="pt-1">
        <KindGlyph event={lead} words={words} />
        <span className="sr-only">{words.level === undefined ? lead.kind : words.level}</span>
      </span>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {words.level !== undefined && (
            <span
              className={cn(
                'rounded-full border px-2 text-xs font-semibold',
                MARK_COLOR[words.level],
              )}
            >
              {LEVEL_WORD[words.level]}
            </span>
          )}
          <Title line={line} words={words} />
          <Link
            className="rounded-md bg-secondary px-1.5 text-xs text-muted-foreground break-all"
            params={{ name: line.system }}
            to="/systems/$name"
          >
            {line.system}
          </Link>
          {unpaired && <span className={cn(MARKER, 'text-muted-foreground')}>unpaired</span>}
          {words.open && <span className={cn(MARKER, 'text-muted-foreground')}>open</span>}
          {words.alert !== undefined && (
            <span className={cn(MARKER, 'text-muted-foreground')}>alert sent</span>
          )}
        </p>
        {(words.detail !== '' || words.alert !== undefined) && (
          <p className="mt-0.5 text-[13px] text-muted-foreground wrap-anywhere">
            {words.detail}
            {words.detail !== '' && words.alert !== undefined && ' · '}
            {words.alert !== undefined && (
              <>
                Alert pushed at {formatClock(words.alert.at, timeZone)}
                {words.alert.recoveredAt !== undefined &&
                  `, recovery at ${formatClock(words.alert.recoveredAt, timeZone)}`}
              </>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

// The lines under a heading for each local day, in the order given.
export function ActivityListBody({
  lines,
  now,
  onPick,
  pinned,
  timeZone,
  unpaired,
}: {
  lines: readonly ActivityLine[];
  now: number;
  onPick?: ((line: ActivityLine) => void) | undefined;
  pinned?: Pin | undefined;
  timeZone: string;
  unpaired: ReadonlySet<string>;
}) {
  return (
    <>
      {groupByDay(lines, now, timeZone).map((group, index) => (
        // The same day can head two groups only if lines arrive out of order.
        // oxlint-disable-next-line react/no-array-index-key
        <section className="mt-5 first:mt-0" key={`${String(index)}-${String(group.key)}`}>
          <h2 className="mb-1 text-[11px] font-semibold tracking-[0.08em] text-dim uppercase">
            {group.heading}
          </h2>
          <ol>
            {group.entries.map((line) => (
              <Line
                key={`${line.system}@${String(line.at)}@${line.events[0]?.kind ?? ''}`}
                line={line}
                onPick={onPick}
                pinned={isPinned(line, pinned)}
                timeZone={timeZone}
                unpaired={unpaired.has(line.system)}
              />
            ))}
          </ol>
        </section>
      ))}
    </>
  );
}

// The list once the viewer's zone is known, as the days and times depend on it.
export function ActivityList(props: {
  lines: readonly ActivityLine[];
  now: number;
  onPick?: ((line: ActivityLine) => void) | undefined;
  pinned?: Pin | undefined;
  unpaired: ReadonlySet<string>;
}) {
  return <InZone>{(timeZone) => <ActivityListBody {...props} timeZone={timeZone} />}</InZone>;
}
