import { Area, ComposedChart, Line, XAxis, YAxis } from 'recharts';

import { memoryRows } from '../lib/detail.ts';
import type { Window } from '../lib/time.ts';
import type { MemoryBucket } from '../server/system-detail-types.ts';
import { ChartContainer } from './ui/chart.tsx';
import type { ChartConfig } from './ui/chart.tsx';

const HEIGHT = 44;
const GIB = 1024 ** 3;
const NO_MARGIN = { bottom: 0, left: 0, right: 0, top: 0 };
const CONFIG = { used: { color: 'var(--foreground)', label: 'Memory used' } } satisfies ChartConfig;

// Memory used per 5-minute bucket, on a scale up to the memory the System has.
export function MemoryPlot({
  buckets,
  window,
}: {
  buckets: readonly MemoryBucket[];
  window: Window;
}) {
  const total = Math.max(1, ...buckets.map((bucket) => bucket.totalBytes / GIB));
  return (
    <ChartContainer
      aria-label="Memory used"
      className="aspect-auto w-full"
      config={CONFIG}
      initialDimension={{ height: HEIGHT, width: 1000 }}
      role="img"
      style={{ height: HEIGHT }}
    >
      <ComposedChart data={memoryRows(buckets, window)} margin={NO_MARGIN}>
        <XAxis allowDataOverflow dataKey="t" domain={[window.from, window.to]} hide type="number" />
        <YAxis domain={[0, total]} hide />
        <Area
          activeDot={false}
          dataKey="used"
          fill="rgba(150, 170, 215, 0.14)"
          isAnimationActive={false}
          stroke="none"
        />
        <Line
          activeDot={false}
          dataKey="used"
          dot={false}
          isAnimationActive={false}
          stroke="#d5dbea"
          strokeWidth={1.25}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
