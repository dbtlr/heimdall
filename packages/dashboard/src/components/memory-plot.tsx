import { Area, ComposedChart, Line, XAxis, YAxis } from 'recharts';

import type { Domain } from '../lib/chart-scale.ts';
import { memoryRows } from '../lib/detail.ts';
import type { Window } from '../lib/time.ts';
import type { MemoryBucket } from '../server/system-detail-types.ts';
import { PLOT_COLOR, PlotGradient, ScaledPlot, usePlotGradientId } from './plot-scale.tsx';
import { ChartContainer } from './ui/chart.tsx';
import type { ChartConfig } from './ui/chart.tsx';

const HEIGHT = 44;
const GIB = 1024 ** 3;
const NO_MARGIN = { bottom: 0, left: 0, right: 0, top: 0 };
const CONFIG = { used: { color: PLOT_COLOR, label: 'Memory used' } } satisfies ChartConfig;

// A GiB figure for the scale, whole from 10 up; the top label names the unit.
const gibLabel =
  (top: number) =>
  (value: number): string => {
    if (value === 0) {
      return '0';
    }
    const figure = value.toFixed(value >= 10 ? 0 : 1);
    return value === top ? `${figure} GiB` : figure;
  };

// Memory used per 5-minute bucket, on a scale up to the memory the System has,
// as a line over a gradient fill.
export function MemoryPlot({
  buckets,
  window,
}: {
  buckets: readonly MemoryBucket[];
  window: Window;
}) {
  const fill = usePlotGradientId();
  const total = Math.max(1, ...buckets.map((bucket) => bucket.totalBytes / GIB));
  const domain: Domain = [0, total];
  return (
    <ScaledPlot domain={domain} format={gibLabel(total)} height={HEIGHT}>
      <PlotGradient color={PLOT_COLOR} id={fill} />
      <ChartContainer
        aria-label="Memory used"
        className="aspect-auto w-full"
        config={CONFIG}
        initialDimension={{ height: HEIGHT, width: 1000 }}
        role="img"
        style={{ height: HEIGHT }}
      >
        <ComposedChart data={memoryRows(buckets, window)} margin={NO_MARGIN}>
          <XAxis
            allowDataOverflow
            dataKey="t"
            domain={[window.from, window.to]}
            hide
            type="number"
          />
          <YAxis domain={domain} hide />
          <Area
            activeDot={false}
            dataKey="used"
            fill={`url(#${fill})`}
            isAnimationActive={false}
            stroke="none"
          />
          <Line
            activeDot={false}
            dataKey="used"
            dot={false}
            isAnimationActive={false}
            stroke={PLOT_COLOR}
            strokeWidth={1.5}
          />
        </ComposedChart>
      </ChartContainer>
    </ScaledPlot>
  );
}
