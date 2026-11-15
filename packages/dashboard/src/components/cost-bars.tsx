import { spanHolding } from '../lib/bucket-edges.ts';
import { niceDomain } from '../lib/chart-scale.ts';
import { harnessColor, harnessName } from '../lib/lane.ts';
import { costBars } from '../lib/long-history.ts';
import type { CostBar } from '../lib/long-history.ts';
import { formatCost, spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import type { CostBucket } from '../server/system-detail-types.ts';
import { DetailTrack } from './detail-track.tsx';
import { ScaledPlot } from './plot-scale.tsx';

// A figure for the scale: whole dollars, or cents when the tick is a fraction
// of one, so each label states its value.
export const dollars = (value: number): string =>
  Number.isInteger(value) ? `$${String(value)}` : `$${value.toFixed(2)}`;

// What a bar's tooltip says: its Harness parts, led by "No list price" when no
// request in the day was priced and "At least" when some were not.
export const barWords = (bar: CostBar): string => {
  const parts = bar.parts
    .map(({ costUsd, harness }) => `${harnessName(harness)} $${costUsd.toFixed(2)}`)
    .join(', ');
  if (bar.unpriced === 0) {
    return parts;
  }
  return bar.totalUsd === 0 ? 'No list price' : `At least ${formatCost(bar.totalUsd)}: ${parts}`;
};

// The list-price cost of the System's requests per local day over a long
// range, one bar per day of `edges` stacked by Harness in its color, on a scale
// from $0 to the costliest day. A bar spans its day on the shared axis, so it
// lines up with the Vitals buckets above and below it.
export function CostBars({
  costs,
  edges,
  height = 64,
  scaleBeside = false,
  window,
}: {
  costs: readonly CostBucket[];
  edges: readonly number[];
  height?: number;
  scaleBeside?: boolean;
  window: Window;
}) {
  const bars = costBars(costs);
  const top = Math.max(0, ...bars.map(({ totalUsd }) => totalUsd));
  const domain = niceDomain([0, Math.max(1, top)], top >= 10 ? 5 : 0.5);
  return (
    <DetailTrack>
      <ScaledPlot
        beside={scaleBeside}
        domain={domain}
        format={dollars}
        height={height}
        labelled={bars.length > 0}
      >
        <div aria-label="Agent cost per bucket" className="absolute inset-0" role="img">
          {bars.map((bar) => {
            const { left, width } = spanBox(
              { end: spanHolding(edges, bar.t)?.end ?? bar.t, start: bar.t },
              window,
            );
            return (
              <div
                className="absolute inset-y-0 flex flex-col-reverse"
                key={bar.t}
                style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
                title={barWords(bar)}
              >
                {bar.parts.map(({ costUsd, harness }) => (
                  <i
                    // A gap each side keeps neighboring bars apart.
                    className="mx-[12%] block min-w-px last:rounded-t-[1px]"
                    key={harness}
                    style={{
                      backgroundColor: harnessColor(harness),
                      height: `${String((costUsd / domain[1]) * 100)}%`,
                    }}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </ScaledPlot>
    </DetailTrack>
  );
}
