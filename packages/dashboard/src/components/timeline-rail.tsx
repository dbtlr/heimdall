import { KIND_NAMES, SEVERITY } from '../lib/conditions.ts';
import { timelineWhen } from '../lib/detail.ts';
import { cn } from '../lib/utils.ts';
import type { TimelineEntry } from '../server/system-detail-types.ts';
import { ConditionGlyph } from './condition-glyph.tsx';
import { PhraseText } from './date-time.tsx';

// The System's Timeline: each Condition of the last 7 days and each still
// open, open first, then newest raised, with when and why.
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
          {entries.map((entry) => (
            <li
              className={cn(
                '-ml-[7px] flex items-start gap-2.5 py-1.5 pl-3',
                entry.clearedAt === undefined && 'rounded-md bg-[rgba(250,178,25,0.08)]',
              )}
              key={`${entry.kind}-${entry.subject}-${String(entry.raisedAt)}`}
            >
              <ConditionGlyph className="mt-1" kind={SEVERITY[entry.kind]} />
              <div className="min-w-0">
                <p className="break-words">
                  <b className="font-semibold">{KIND_NAMES[entry.kind]}</b>
                  {entry.subject !== '' && ` ${entry.subject}`}
                </p>
                <p className="text-muted-foreground">
                  <PhraseText phrase={timelineWhen(entry, now)} />
                </p>
                <p className="text-[12.5px] whitespace-pre-wrap text-muted-foreground">
                  {entry.reason}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
