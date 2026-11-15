import { niceDomain } from '../lib/chart-scale.ts';
import { harnessColor, harnessName } from '../lib/lane.ts';
import { costBars } from '../lib/long-history.ts';
import { spanBox } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import type { CostBucket } from '../server/system-detail-types.ts';
import { DetailTrack } from './detail-track.tsx';
import { ScaledPlot } from './plot-scale.tsx';

// A whole-dollar figure for the scale.
const dollars = (value: number): string => `$${String(Math.round(value))}`;

// The list-price cost of the System's requests per bucket over a long range,
// one bar per bucket stacked by Harness in its color, on a scale from $0 to the
// costliest bucket. A bar spans its bucket on the shared axis, so it lines up
// with the Vitals buckets above and below it.
export function CostBars({
  bucketMs,
  costs,
  height = 64,
  scaleBeside = false,
  window,
}: {
  bucketMs: number;
  costs: readonly CostBucket[];
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
            const { left, width } = spanBox({ end: bar.t + bucketMs, start: bar.t }, window);
            return (
              <div
                className="absolute inset-y-0 flex flex-col-reverse"
                key={bar.t}
                style={{ left: `${String(left)}%`, width: `${String(width)}%` }}
                title={bar.parts
                  .map(({ costUsd, harness }) => `${harnessName(harness)} $${costUsd.toFixed(2)}`)
                  .join(', ')}
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
