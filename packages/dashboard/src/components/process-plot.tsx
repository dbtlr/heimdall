import { Area, ComposedChart, Line, XAxis, YAxis } from 'recharts';

import type { Domain } from '../lib/chart-scale.ts';
import { processRows } from '../lib/detail.ts';
import { harnessColor } from '../lib/lane.ts';
import type { Window } from '../lib/time.ts';
import type { ProcessSeries } from '../server/system-detail-types.ts';
import { PlotGradient, ScaledPlot, usePlotGradientId } from './plot-scale.tsx';
import { ChartContainer } from './ui/chart.tsx';

const HEIGHT = 60;
const NO_MARGIN = { bottom: 0, left: 0, right: 0, top: 0 };

// A cores figure for the scale, to one decimal; the top label names the unit.
const coresLabel =
  (top: number) =>
  (value: number): string => {
    const figure = String(Math.round(value * 10) / 10);
    return value === top ? `${figure} ${figure === '1' ? 'core' : 'cores'}` : figure;
  };

// The CPU cores each Harness process tree kept busy per bucket, 5 minutes
// unless `bucketMs` says otherwise, one line per process in its Harness's
// color over a gradient fill, on a scale from 0 to the busiest.
export function ProcessPlot({
  bucketMs,
  processes,
  window,
}: {
  bucketMs?: number;
  processes: readonly ProcessSeries[];
  window: Window;
}) {
  const fill = usePlotGradientId();
  const busiest = Math.max(
    1,
    ...processes.flatMap((process) => process.points.map((point) => point.cores ?? 0)),
  );
  const domain: Domain = [0, busiest];
  return (
    <ScaledPlot domain={domain} format={coresLabel(busiest)} height={HEIGHT}>
      {processes.map((process) => (
        <PlotGradient
          color={harnessColor(process.harness)}
          id={`${fill}-${String(process.processId)}`}
          key={process.processId}
        />
      ))}
      <ChartContainer
        aria-label="CPU cores per Harness process"
        className="aspect-auto w-full"
        config={{}}
        initialDimension={{ height: HEIGHT, width: 1000 }}
        role="img"
        style={{ height: HEIGHT }}
      >
        <ComposedChart data={processRows(processes, window, bucketMs)} margin={NO_MARGIN}>
          <XAxis
            allowDataOverflow
            dataKey="t"
            domain={[window.from, window.to]}
            hide
            type="number"
          />
          <YAxis domain={domain} hide />
          {processes.map((process) => (
            <Area
              activeDot={false}
              dataKey={`p${String(process.processId)}`}
              fill={`url(#${fill}-${String(process.processId)})`}
              fillOpacity={0.6}
              isAnimationActive={false}
              key={`fill-${String(process.processId)}`}
              stroke="none"
            />
          ))}
          {processes.map((process) => (
            <Line
              activeDot={false}
              dataKey={`p${String(process.processId)}`}
              dot={false}
              isAnimationActive={false}
              key={process.processId}
              stroke={harnessColor(process.harness)}
              strokeWidth={1.5}
            />
          ))}
        </ComposedChart>
      </ChartContainer>
    </ScaledPlot>
  );
}
