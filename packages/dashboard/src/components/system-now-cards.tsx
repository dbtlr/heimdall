import type { ReactNode } from 'react';

import { formatGiB } from '../lib/detail.ts';
import { formatLoad } from '../lib/facts.ts';
import { diskReading, meterLevels } from '../lib/fleet-tile.ts';
import { RANGE_LABELS } from '../lib/range.ts';
import { sparklineAreaPath, sparklinePath } from '../lib/sparkline.ts';
import type { SparkPoint } from '../lib/sparkline.ts';
import { formatSpanShort } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type { SystemDetail } from '../server/system-detail-types.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { DateTime } from './date-time.tsx';
import {
  PERCENT_DOMAIN,
  PLOT_COLOR,
  PlotGradient,
  ScaledPlot,
  usePlotGradientId,
} from './plot-scale.tsx';

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 48;

// A percentage line of the points over a gradient fill, with gaps breaking
// it, on a 0 to 100% scale. Decorative: the card says the values.
function Sparkline({
  detail,
  points,
}: {
  detail: Pick<SystemDetail, 'from' | 'gaps' | 'to'>;
  points: readonly SparkPoint[];
}) {
  const fill = usePlotGradientId();
  const box = {
    ceiling: 100,
    from: detail.from,
    height: SPARK_HEIGHT,
    to: detail.to,
    width: SPARK_WIDTH,
  };
  return (
    <ScaledPlot className="mt-2" domain={PERCENT_DOMAIN} gutter height={SPARK_HEIGHT}>
      <PlotGradient color={PLOT_COLOR} id={fill} />
      <svg
        aria-hidden="true"
        className="block size-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${String(SPARK_WIDTH)} ${String(SPARK_HEIGHT)}`}
      >
        <path d={sparklineAreaPath(points, detail.gaps, box)} fill={`url(#${fill})`} />
        <path
          d={sparklinePath(points, detail.gaps, box)}
          fill="none"
          stroke={PLOT_COLOR}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          style={{ vectorEffect: 'non-scaling-stroke' }}
        />
      </svg>
    </ScaledPlot>
  );
}

// One card: a big value, its caption, and optionally a line under them.
function Card({
  caption,
  children,
  muted,
  value,
  valueClass,
}: {
  caption: ReactNode;
  children?: ReactNode;
  muted: boolean;
  value: ReactNode;
  valueClass?: string | undefined;
}) {
  return (
    <div className={cn('card-surface rounded-xl border px-3.5 py-3', muted && 'opacity-50')}>
      <div className={cn('text-2xl leading-tight font-semibold tabular-nums', valueClass)}>
        {value}
      </div>
      <div className="text-sm text-muted-foreground">{caption}</div>
      {children}
    </div>
  );
}

// A load average, or a dash when the Collector did not report one.
const loadText = (load: number): string => (Number.isFinite(load) ? formatLoad(load) : '—');

const percent = (value: number): string => `${String(Math.round(value))}%`;

// From `lg`, four cards for the newest Vitals sample: CPU busy and Memory with
// their line over the loaded range, the Disk the tiles read, and Load. Values
// from a sample older than QUIET_AFTER_MS are muted and dated for screen readers.
export function SystemNowCards({
  detail,
  items,
}: {
  detail: Pick<
    SystemDetail,
    'cpu' | 'from' | 'gaps' | 'latest' | 'memory' | 'now' | 'range' | 'to'
  >;
  items: readonly Attention[];
}) {
  const { latest, now } = detail;
  if (latest === undefined) {
    return (
      <p className="mb-3 hidden py-2 text-muted-foreground lg:block">
        No Vitals sample has arrived.
      </p>
    );
  }
  const stale = now - latest.t > QUIET_AFTER_MS;
  const disk = diskReading(latest.disks, items);
  const diskLevel = meterLevels(items).disk;
  const high = Math.max(
    latest.cpuBusyPercent,
    ...detail.cpu.map(({ high: bucketHigh }) => bucketHigh),
  );
  const cpuPoints = detail.cpu.map(({ average, t }) => ({ t, value: average }));
  const memoryPoints = detail.memory
    .filter(({ totalBytes }) => totalBytes > 0)
    .map(({ t, totalBytes, usedBytes }) => ({ t, value: (usedBytes / totalBytes) * 100 }));
  const [load1, load5, load15] = latest.load;
  const used = formatGiB(latest.memoryUsedBytes);
  const total = formatGiB(latest.memoryTotalBytes);
  return (
    <section
      aria-labelledby="now-cards-heading"
      className="mb-4 hidden lg:grid lg:grid-cols-4 lg:gap-3"
    >
      <div className="flex items-baseline gap-3 lg:col-span-4">
        <h2 className="text-lg font-semibold" id="now-cards-heading">
          Last reported
        </h2>
        {/* As on the phone: a System's clock alone cannot prove freshness, so say when. */}
        <p className="text-sm text-muted-foreground">
          Sample time <DateTime at={latest.t} format="when" now={now} />.
        </p>
      </div>
      {stale && <span className="sr-only">Vitals as of {formatSpanShort(now - latest.t)} ago</span>}
      <Card
        caption={
          detail.cpu.length === 0
            ? 'CPU busy'
            : `CPU busy · ${RANGE_LABELS[detail.range]} high ${percent(high)}`
        }
        muted={stale}
        value={percent(latest.cpuBusyPercent)}
      >
        <Sparkline detail={detail} points={cpuPoints} />
      </Card>
      <Card
        caption="memory"
        muted={stale}
        value={
          <>
            {used}
            <span className="text-base font-normal text-muted-foreground"> of {total} GiB</span>
          </>
        }
      >
        <Sparkline detail={detail} points={memoryPoints} />
      </Card>
      <Card
        caption={disk === undefined ? 'No disk sample' : `disk ${disk.mount}`}
        muted={stale}
        value={disk === undefined ? '—' : percent(disk.percent)}
        valueClass={diskLevel === undefined ? undefined : MARK_COLOR[diskLevel]}
      />
      <Card
        caption={`load · 5-min ${loadText(load5)} · 15-min ${loadText(load15)}`}
        muted={stale}
        value={loadText(load1)}
      />
    </section>
  );
}
