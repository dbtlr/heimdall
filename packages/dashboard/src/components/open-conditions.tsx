import { KIND_NAMES, SEVERITY } from '../lib/conditions.ts';
import { formatWhen } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { OpenCondition } from '../server/fleet-overview-types.ts';
import { ConditionGlyph } from './condition-glyph.tsx';

// Every Condition open now, newest raised first, those on unpaired Systems last and tagged.
export function OpenConditions({
  now,
  open,
  timeZone,
}: {
  now: number;
  open: readonly OpenCondition[];
  timeZone: string;
}) {
  return (
    <section className="mt-[18px] rounded-lg bg-card p-4">
      <h2 className="mb-2 text-[12.5px] font-normal text-muted-foreground">Open now</h2>
      {open.length === 0 ? (
        <p>Nothing is open.</p>
      ) : (
        <ul>
          {open.map((condition) => (
            <li
              className={cn(
                'flex items-baseline gap-2.5 py-[5px]',
                condition.unpaired && 'opacity-70',
              )}
              key={`${condition.system}-${condition.kind}-${condition.subject}`}
            >
              <ConditionGlyph kind={SEVERITY[condition.kind]} />
              <span className="min-w-0 flex-1">
                <b className="font-semibold">{KIND_NAMES[condition.kind]}</b> on {condition.system}
                {condition.subject === '' ? '' : `, ${condition.subject}`}. {condition.reason}
                {condition.unpaired && (
                  <em className="ml-1 rounded border px-[5px] text-xs text-muted-foreground not-italic">
                    unpaired
                  </em>
                )}
              </span>
              <time className="shrink-0 text-muted-foreground">
                {formatWhen(condition.raisedAt, now, timeZone)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
