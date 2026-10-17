import { Area, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from 'recharts';

import type { ChartView } from '../lib/condition-detail.ts';
import { LEVEL_STROKE } from './condition-colors.ts';
import { ChartContainer } from './ui/chart.tsx';
import type { ChartConfig } from './ui/chart.tsx';

const HEIGHT = 168;
const NO_MARGIN = { bottom: 4, left: 0, right: 0, top: 4 };
const CONFIG = { value: { color: 'var(--foreground)', label: 'Reading' } } satisfies ChartConfig;

// One reading over the window as a line with a faint area, and a dashed line
// across it at each limit that sets a level, in that level's colour. The x axis
// is the window, so a gap in the readings is a break in the line.
export function ConditionChart({ chart }: { chart: ChartView }) {
  return (
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
        {chart.lines.map((line) => (
          <ReferenceLine
            ifOverflow="extendDomain"
            key={line.level}
            label={{
              fill: LEVEL_STROKE[line.level],
              fontSize: 11,
              position: 'insideTopRight',
              value: line.label,
            }}
            stroke={LEVEL_STROKE[line.level]}
            strokeDasharray="4 3"
            y={line.value}
          />
        ))}
        <Area
          activeDot={false}
          dataKey="value"
          fill="rgba(150, 170, 215, 0.14)"
          isAnimationActive={false}
          stroke="none"
        />
        <Line
          activeDot={false}
          dataKey="value"
          dot={false}
          isAnimationActive={false}
          stroke="#d5dbea"
          strokeWidth={1.5}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
