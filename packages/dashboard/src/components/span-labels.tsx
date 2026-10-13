import { spanTicks } from '../lib/axis.ts';
import { xPercent } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';

const ALIGN = { end: '-translate-x-full', middle: '-translate-x-1/2', start: '' } as const;

// Time labels under a chart that spans a Session's whole width, with no lane
// label beside it. A narrow screen drops the minor ones.
export function SpanLabels({ timeZone, window }: { timeZone: string; window: Window }) {
  return (
    <div className="relative mt-0.5 h-4 text-[11.5px] text-muted-foreground">
      {spanTicks(window, timeZone).map((tick) => (
        <span
          className={cn('absolute', ALIGN[tick.edge], tick.minor && 'hidden sm:block')}
          key={tick.at}
          style={{ left: `${String(xPercent(tick.at, window))}%` }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}
