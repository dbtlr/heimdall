import { KIND_NAMES, transitionLabel } from '../lib/conditions.ts';
import { timelineWhen } from '../lib/detail.ts';
import { cn } from '../lib/utils.ts';
import type { TimelineEntry } from '../server/system-detail-types.ts';
import { ConditionGlyph } from './condition-glyph.tsx';
import { DateTime, PhraseText } from './date-time.tsx';
import { MoreItems } from './more-items.tsx';

// An occurrence keeps the Hub's transition order, including backfilled levels.
function Occurrence({ entry, now }: { entry: TimelineEntry; now: number }) {
  return (
    <li
      className={cn(
        '-ml-[7px] flex items-start gap-2.5 py-1.5 pl-3',
        entry.clearedAt === undefined && 'rounded-md bg-[rgba(250,178,25,0.08)]',
      )}
    >
      <ConditionGlyph className="mt-1" kind={entry.level} />
      <div className="min-w-0">
        <p className="break-words">
          <b className="font-semibold">{KIND_NAMES[entry.kind]}</b>
          {entry.subject !== '' && ` ${entry.subject}`}
        </p>
        <p className="text-muted-foreground">
          <PhraseText phrase={timelineWhen(entry, now)} />
        </p>
        <p className="text-[12.5px] whitespace-pre-wrap text-muted-foreground">{entry.reason}</p>
        <ol className="mt-1 max-h-[25dvh] space-y-1 overflow-y-auto text-[12.5px] text-muted-foreground">
          {entry.transitions.map((transition, index) => (
            // The Hub's recording order distinguishes transitions at the same time.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={index}>
              <p>
                {transitionLabel(transition)}
                {' · '}
                <DateTime at={transition.at} format="when" now={now} />
                {transition.backfilled && ' · Backfilled level'}
              </p>
              <p className="whitespace-pre-wrap">{transition.reason}</p>
            </li>
          ))}
        </ol>
      </div>
    </li>
  );
}

// The System's Timeline: each Condition of the last 7 days and each still
// open, newest raised first, with transitions in the Hub's recording order.
export function TimelineRail({ entries, now }: { entries: readonly TimelineEntry[]; now: number }) {
  return (
    <section className="mt-[18px] self-start rounded-lg bg-card p-4">
      <h2 className="mb-2 text-[12.5px] font-normal text-muted-foreground">
        Timeline, last 7 days
      </h2>
      {entries.length === 0 ? (
        <p>No Condition in the last 7 days.</p>
      ) : (
        <ol className="border-l-2 pl-1">
          {entries.slice(0, 3).map((entry) => (
            <Occurrence entry={entry} key={entry.id} now={now} />
          ))}
          {entries.length > 3 && (
            <li>
              <MoreItems label={`Show ${String(entries.length - 3)} more occurrences`}>
                <ol>
                  {entries.slice(3).map((entry) => (
                    <Occurrence entry={entry} key={entry.id} now={now} />
                  ))}
                </ol>
              </MoreItems>
            </li>
          )}
        </ol>
      )}
    </section>
  );
}
