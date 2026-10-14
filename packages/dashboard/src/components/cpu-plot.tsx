import { Area, ComposedChart, Line, XAxis, YAxis } from 'recharts';

import { cpuSeries } from '../lib/lane.ts';
import { clockSpan } from '../lib/phrase.ts';
import type { Window } from '../lib/time.ts';
import type { CpuBucket } from '../server/fleet-overview-types.ts';
import { PhraseText } from './date-time.tsx';
import { ChartContainer, ChartTooltip } from './ui/chart.tsx';
import type { ChartConfig } from './ui/chart.tsx';

const BUCKET_MS = 5 * 60_000;
const NO_MARGIN = { bottom: 0, left: 0, right: 0, top: 0 };
const CONFIG = { average: { color: 'var(--foreground)', label: 'CPU busy' } } satisfies ChartConfig;

const percent = (value: number) => `${String(Math.round(value))}%`;

// The tooltip for the hovered bucket.
function BucketTooltip({
  active,
  bucketMs,
  buckets,
  label,
}: {
  active?: boolean | undefined;
  bucketMs: number;
  buckets: readonly CpuBucket[];
  label?: number | string | undefined;
}) {
  const bucket =
    typeof label === 'number'
      ? buckets.find((found) => found.t <= label && label <= found.t + bucketMs)
      : undefined;
  if (active !== true || bucket === undefined) {
    return null;
  }
  return (
    <div className="rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
      <p className="text-muted-foreground">
        <PhraseText phrase={clockSpan(bucket.t, bucket.t + bucketMs)} />
      </p>
      <p>
        CPU {percent(bucket.average)}, low {percent(bucket.low)}, high {percent(bucket.high)}
      </p>
    </div>
  );
}

// A System's CPU busy over the window: each bucket's low to high as a band, the
// average as a line. The x axis is the window, so every lane lines up, and a
// gap in the Vitals is a break in the line.
export function CpuPlot({
  bucketMs = BUCKET_MS,
  buckets,
  height = 46,
  label,
  window,
}: {
  bucketMs?: number;
  buckets: readonly CpuBucket[];
  height?: number;
  label: string;
  window: Window;
}) {
  return (
    <ChartContainer
      aria-label={label}
      className="aspect-auto w-full"
      config={CONFIG}
      initialDimension={{ height, width: 1000 }}
      role="img"
      style={{ height }}
    >
      <ComposedChart data={cpuSeries(buckets, bucketMs)} margin={NO_MARGIN}>
        <XAxis allowDataOverflow dataKey="t" domain={[window.from, window.to]} hide type="number" />
        <YAxis domain={[0, 100]} hide />
        <ChartTooltip
          content={({ active, label: at }) => (
            <BucketTooltip active={active} bucketMs={bucketMs} buckets={buckets} label={at} />
          )}
        />
        <Area
          activeDot={false}
          dataKey="band"
          fill="rgba(150, 170, 215, 0.22)"
          isAnimationActive={false}
          stroke="none"
        />
        <Line
          activeDot={false}
          dataKey="average"
          dot={false}
          isAnimationActive={false}
          stroke="#d5dbea"
          strokeWidth={1.25}
        />
      </ComposedChart>
    </ChartContainer>
  );
}
