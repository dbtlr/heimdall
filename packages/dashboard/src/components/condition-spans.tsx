import { conditionSubject, KIND_NAMES, LEVEL_FILL } from '../lib/conditions.ts';
import { markSpan } from '../lib/lane.ts';
import { phraseTitle } from '../lib/phrase.ts';
import { spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { cn } from '../lib/utils.ts';
import type { ConditionMark } from '../server/fleet-overview-types.ts';
import { PhraseText } from './date-time.tsx';

const ROW_PX = 18;

// Where a bar's label goes: after the bar when there is room, else before it,
// else over its start when the bar spans most of the window.
const conditionLabelPlace = ({ left, width }: { left: number; width: number }) => {
  if (left + width <= 70) {
    return { style: { left: `calc(${String(left + width)}% + 8px)` } };
  }
  if (left >= 30) {
    return { style: { right: `calc(${String(100 - left)}% + 8px)` } };
  }
  return { over: true, style: { left: `calc(${String(left)}% + 8px)` } };
};

// Each Condition open during the window as a bar from raised to cleared, with
// what it was and when beside it, one to a line.
export function ConditionSpans({
  conditions,
  now,
  window,
}: {
  conditions: readonly ConditionMark[];
  now: number;
  window: Window;
}) {
  const timeZone = useTimeZone();
  const visible = conditions.filter(
    (mark) => mark.raisedAt <= window.to && (mark.clearedAt ?? window.to) >= window.from,
  );
  if (visible.length === 0) {
    return (
      <p className="text-[12.5px] leading-[18px] text-muted-foreground">None in this range.</p>
    );
  }
  return (
    <div className="relative overflow-hidden" style={{ height: visible.length * ROW_PX }}>
      {visible.map((mark, row) => {
        const end = mark.clearedAt ?? window.to;
        const { left, width } = spanBox({ end, start: mark.raisedAt }, window);
        const what = `${KIND_NAMES[mark.kind]}${mark.subject === '' ? '' : ` ${conditionSubject(mark)}`}`;
        const labelStyle = conditionLabelPlace({ left, width });
        return (
          <div key={mark.id} style={{ height: ROW_PX }}>
            {mark.transitions.map((transition, index) => {
              const next = mark.transitions[index + 1];
              if (
                transition.kind === 'cleared' ||
                transition.at > window.to ||
                (next?.at ?? end) < window.from
              ) {
                return null;
              }
              const segment = spanBox({ end: next?.at ?? end, start: transition.at }, window);
              return (
                <div
                  className={cn(
                    'absolute h-2 min-w-[3px] rounded-[2px]',
                    LEVEL_FILL[transition.level],
                  )}
                  // oxlint-disable-next-line react/no-array-index-key -- recording order distinguishes equal timestamps.
                  key={index}
                  style={{
                    left: `${String(segment.left)}%`,
                    top: row * ROW_PX + 5,
                    width: `${String(segment.width)}%`,
                  }}
                  title={
                    phraseTitle(
                      [
                        `${what}, ${transition.level}${transition.backfilled ? ' (Backfilled level)' : ''}, `,
                        ...markSpan(mark, now),
                      ],
                      timeZone,
                    ) ?? what
                  }
                />
              );
            })}
            <span
              className={cn(
                'absolute text-xs whitespace-nowrap text-muted-foreground',
                'over' in labelStyle && 'rounded-[3px] bg-background px-1',
              )}
              style={{ ...labelStyle.style, top: row * ROW_PX + 1 }}
            >
              {what}
              <PhraseText phrase={[' ', ...markSpan(mark, now)]} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
