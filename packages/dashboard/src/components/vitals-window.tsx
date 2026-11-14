import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { spanTicks } from '../lib/axis.ts';
import { spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { vitalsView } from '../lib/vitals-window.ts';
import type { VitalsWindow } from '../server/vitals-window-types.ts';
import { ConditionChart } from './condition-chart.tsx';
import { TimeAxis } from './time-axis.tsx';

const PLOT_HEIGHT = 56;

// The shade behind a plot at `shade`, in the selection color. A span too short to
// see, such as a restart of a few seconds, is drawn as wide as a hairline.
function Shade({ shade, window }: { shade: Window; window: Window }) {
  const { left, width } = spanBox({ end: shade.to, start: shade.from }, window);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 min-w-0.5 border-x border-select/50 bg-select/20"
      data-shade
      style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
    />
  );
}

// The System's CPU, memory, and load over a window, one plot each on a shared
// time axis, with the `shade` span marked on every plot: the stop, or the time
// the Condition was open. `title` heads the card.
export function VitalsWindowCard({
  shade,
  title,
  vitals,
}: {
  shade: Window;
  title: ReactNode;
  vitals: VitalsWindow;
}) {
  const view = useMemo(() => vitalsView(vitals), [vitals]);
  const timeZone = useTimeZone();
  return (
    <section className="card-surface min-w-0 rounded-xl border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{view.source}</p>
      </div>
      {view.empty ? (
        <p className="mt-2 text-base">The Hub holds no Vitals in this window.</p>
      ) : (
        <>
          {view.charts.map(({ chart, key, max }) => (
            <div className="mt-2.5 min-w-0" key={key}>
              <p className="flex justify-between gap-3 text-xs text-muted-foreground">
                <span>{chart.label}</span>
                <span className="tabular-nums">{max}</span>
              </p>
              <div className="relative mt-0.5">
                {/* The shade comes first, so it lies under the plot's scale labels, not through them. */}
                <Shade shade={shade} window={view.window} />
                <ConditionChart chart={chart} height={PLOT_HEIGHT} />
              </div>
            </div>
          ))}
          <TimeAxis
            bare
            ticks={timeZone === undefined ? [] : spanTicks(view.window, timeZone)}
            window={view.window}
          />
        </>
      )}
    </section>
  );
}
