import { SEVERITY } from '../lib/conditions.ts';
import { clearedTitle, raisedTitle } from '../lib/lane.ts';
import { phraseTitle } from '../lib/phrase.ts';
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

// The Conditions raised and cleared within the window, as glyphs under the
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
  return conditions.map((mark) => {
    const key = `${mark.kind}-${mark.subject}-${String(mark.raisedAt)}`;
    return (
      <span key={key}>
        {inWindow(mark.raisedAt, window) && (
          <Mark
            at={mark.raisedAt}
            title={phraseTitle(raisedTitle(mark, now), timeZone)}
            window={window}
          >
            <ConditionGlyph kind={SEVERITY[mark.kind]} />
          </Mark>
        )}
        {mark.clearedAt !== undefined && inWindow(mark.clearedAt, window) && (
          <Mark at={mark.clearedAt} title={clearedTitle(mark)} window={window}>
            <ConditionGlyph kind="cleared" />
          </Mark>
        )}
      </span>
    );
  });
}
