import { Area, ComposedChart, Line, XAxis, YAxis } from 'recharts';

import type { ChartView } from '../lib/condition-detail.ts';
import { isLone } from '../lib/condition-detail.ts';
import { LEVEL_STROKE } from '../lib/conditions.ts';
import { PLOT_COLOR, PlotGradient, ScaledPlot, usePlotGradientId } from './plot-scale.tsx';
import { ChartContainer } from './ui/chart.tsx';
import type { ChartConfig } from './ui/chart.tsx';

const HEIGHT = 168;
const NO_MARGIN = { bottom: 0, left: 0, right: 0, top: 0 };
const CONFIG = { value: { color: PLOT_COLOR, label: 'Reading' } } satisfies ChartConfig;

// A scale label: whole numbers as they are, cores to one decimal.
const scaleLabel = (value: number): string => String(Math.round(value * 10) / 10);

// One reading over the window as a line over a gradient fill, its scale on the
// left, and a dashed line across it at each limit that sets a level, in that
// level's colour. The x axis is the window, so a gap in the readings is a
// break in the line, and a reading alone between gaps is a dot.
export function ConditionChart({ chart }: { chart: ChartView }) {
  const fill = usePlotGradientId();
  return (
    <ScaledPlot
      domain={chart.domain}
      format={scaleLabel}
      height={HEIGHT}
      limits={chart.lines.map((line) => ({
        color: LEVEL_STROKE[line.level],
        label: line.label,
        value: line.value,
      }))}
    >
      <PlotGradient color={PLOT_COLOR} id={fill} />
      <ChartContainer
        aria-label={chart.label}
        className="aspect-auto w-full"
        config={CONFIG}
        initialDimension={{ height: HEIGHT, width: 1000 }}
        role="img"
        style={{ height: HEIGHT }}
      >
        <ComposedChart data={chart.points} margin={NO_MARGIN}>
          <XAxis
            allowDataOverflow
            dataKey="t"
            domain={[chart.window.from, chart.window.to]}
            hide
            type="number"
          />
          <YAxis allowDataOverflow domain={chart.domain} hide />
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
            dot={({ cx, cy, index }: { cx?: number; cy?: number; index: number }) =>
              isLone(chart.points, index) && cx !== undefined && cy !== undefined ? (
                <circle cx={cx} cy={cy} fill={PLOT_COLOR} key={index} r={2} />
              ) : (
                <g key={index} />
              )
            }
            isAnimationActive={false}
            stroke={PLOT_COLOR}
            strokeWidth={1.5}
          />
        </ComposedChart>
      </ChartContainer>
    </ScaledPlot>
  );
}
