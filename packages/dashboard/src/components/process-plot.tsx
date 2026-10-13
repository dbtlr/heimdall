import { ComposedChart, Line, XAxis, YAxis } from 'recharts';

import { processRows } from '../lib/detail.ts';
import { harnessColor } from '../lib/lane.ts';
import type { Window } from '../lib/time.ts';
import type { ProcessSeries } from '../server/system-detail-types.ts';
import { ChartContainer } from './ui/chart.tsx';

const HEIGHT = 60;
const NO_MARGIN = { bottom: 1, left: 0, right: 0, top: 1 };

// The CPU cores each Harness process tree kept busy per 5-minute bucket, one
// line per process in its Harness's color, on a scale from 0 to the busiest.
export function ProcessPlot({
  processes,
  window,
}: {
  processes: readonly ProcessSeries[];
  window: Window;
}) {
  const busiest = Math.max(
    1,
    ...processes.flatMap((process) => process.points.map((point) => point.cores ?? 0)),
  );
  return (
    <ChartContainer
      aria-label="CPU cores per Harness process"
      className="aspect-auto w-full"
      config={{}}
      initialDimension={{ height: HEIGHT, width: 1000 }}
      role="img"
      style={{ height: HEIGHT }}
    >
      <ComposedChart data={processRows(processes, window)} margin={NO_MARGIN}>
        <XAxis allowDataOverflow dataKey="t" domain={[window.from, window.to]} hide type="number" />
        <YAxis domain={[0, busiest]} hide />
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
  );
}
