import { Area, ComposedChart, Line, XAxis, YAxis } from 'recharts';

import { niceDomain } from '../lib/chart-scale.ts';
import { LEVEL_STROKE } from '../lib/conditions.ts';
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

// Memory used per 5-minute bucket, as a line over a gradient fill, on a scale
// from 0 to the memory the System has, widened to a whole GiB from 10 GiB up
// and a tenth of one below, so every label states its position. With no
// bucket, the System's memory is unknown and the scale goes unlabelled.
// `limitPercent` draws the limit the Hub judges memory by, as a share of it.
export function MemoryPlot({
  buckets,
  height = HEIGHT,
  limitPercent,
  window,
}: {
  buckets: readonly MemoryBucket[];
  height?: number;
  limitPercent?: number | undefined;
  window: Window;
}) {
  const fill = usePlotGradientId();
  const total = Math.max(1, ...buckets.map((bucket) => bucket.totalBytes / GIB));
  const domain = niceDomain([0, total], total >= 10 ? 1 : 0.1);
  return (
    <ScaledPlot
      domain={domain}
      format={gibLabel(domain[1])}
      height={height}
      labelled={buckets.length > 0}
      limits={
        limitPercent === undefined || buckets.length === 0
          ? []
          : [
              {
                color: LEVEL_STROKE.note,
                label: `${String(limitPercent)}% limit`,
                value: (total * limitPercent) / 100,
              },
            ]
      }
    >
      <PlotGradient color={PLOT_COLOR} id={fill} />
      <ChartContainer
        aria-label="Memory used"
        className="aspect-auto w-full"
        config={CONFIG}
        initialDimension={{ height, width: 1000 }}
        role="img"
        style={{ height }}
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
