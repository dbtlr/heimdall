import { Area, ComposedChart, Line, XAxis, YAxis } from 'recharts';

import { niceDomain } from '../lib/chart-scale.ts';
import { loadRows } from '../lib/detail.ts';
import type { Window } from '../lib/time.ts';
import type { LoadBucket } from '../server/system-detail-types.ts';
import { PLOT_COLOR, PlotGradient, ScaledPlot, usePlotGradientId } from './plot-scale.tsx';
import { ChartContainer } from './ui/chart.tsx';
import type { ChartConfig } from './ui/chart.tsx';

const NO_MARGIN = { bottom: 0, left: 0, right: 0, top: 0 };
const CONFIG = { value: { color: PLOT_COLOR, label: 'Load' } } satisfies ChartConfig;

// The scale's top: the highest load over the window, widened so its top,
// middle, and bottom are whole numbers, and never under 2.
export const loadDomain = (buckets: readonly LoadBucket[]) => {
  const high = Math.max(2, ...buckets.map(({ value }) => value));
  return niceDomain([0, high], high > 10 ? 5 : 1);
};

// The 1-minute load average per 5-minute bucket, as a line over a gradient
// fill on a scale from 0. A gap in the Vitals is a break in the line.
export function LoadPlot({
  buckets,
  height,
  window,
}: {
  buckets: readonly LoadBucket[];
  height: number;
  window: Window;
}) {
  const fill = usePlotGradientId();
  const domain = loadDomain(buckets);
  return (
    <ScaledPlot
      domain={domain}
      format={(value) => String(value)}
      height={height}
      labelled={buckets.length > 0}
    >
      <PlotGradient color={PLOT_COLOR} id={fill} />
      <ChartContainer
        aria-label="Load, 1 minute"
        className="aspect-auto w-full"
        config={CONFIG}
        initialDimension={{ height, width: 1000 }}
        role="img"
        style={{ height }}
      >
        <ComposedChart data={loadRows(buckets, window)} margin={NO_MARGIN}>
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
            dataKey="value"
            fill={`url(#${fill})`}
            isAnimationActive={false}
            stroke="none"
          />
          <Line
            activeDot={false}
            dataKey="value"
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
