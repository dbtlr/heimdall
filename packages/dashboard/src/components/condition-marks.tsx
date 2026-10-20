import { CONDITION_KIND_NAMES, conditionSubject } from '@heimdall/schema';

import { transitionLabel } from '../lib/conditions.ts';
import { phraseTitle, whenAt } from '../lib/phrase.ts';
import { inWindow, xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import type { ConditionMark } from '../server/fleet-overview-types.ts';
import { ConditionGlyph } from './condition-glyph.tsx';

function Mark({
  children,
  at,
  title,
  window,
}: {
  at: number;
  children: React.ReactNode;
  title: string | undefined;
  window: Window;
}) {
  return (
    <span
      className="absolute -bottom-[5px] -translate-x-1/2 rounded-[3px] bg-background p-0.5 leading-none"
      style={{ left: `${String(xPercent(at, window))}%` }}
      title={title}
    >
      {children}
    </span>
  );
}

// The Conditions raised, changed, and cleared within the window, as glyphs under the
// lane at the time each happened.
export function ConditionMarks({
  conditions,
  now,
  window,
}: {
  conditions: readonly ConditionMark[];
  now: number;
  window: Window;
}) {
  const timeZone = useTimeZone();
  return conditions.map((mark) => (
    <span key={mark.id}>
      {mark.transitions.map((transition, index) =>
        inWindow(transition.at, window) ? (
          <Mark
            at={transition.at}
            // oxlint-disable-next-line react/no-array-index-key -- recording order distinguishes equal timestamps.
            key={index}
            title={phraseTitle(
              [
                `${CONDITION_KIND_NAMES[mark.kind]}${mark.subject === '' ? '' : `, ${conditionSubject(mark)}`}: ${transitionLabel(transition)}${transition.backfilled ? ' (Backfilled level)' : ''}, `,
                whenAt(transition.at, now),
                `. ${transition.reason}`,
              ],
              timeZone,
            )}
            window={window}
          >
            <ConditionGlyph kind={transition.kind === 'cleared' ? 'cleared' : transition.level} />
          </Mark>
        ) : null,
      )}
    </span>
  ));
}
