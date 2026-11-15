import { axisTicks } from '../lib/axis.ts';
import { formatGiB, idleProcessesLabel, splitIdleProcesses } from '../lib/detail.ts';
import { CHANGE_BIN_MS } from '../lib/long-history.ts';
import { formatClock, formatDate, pinnedX } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { cn } from '../lib/utils.ts';
import { isLongRange } from '../server/fleet-overview-types.ts';
import type { LongRange } from '../server/fleet-overview-types.ts';
import type {
  BucketInspection,
  LongHistory,
  SampleInspection,
  SystemDetail,
} from '../server/system-detail-types.ts';
import { ConditionSpans } from './condition-spans.tsx';
import { CostBars } from './cost-bars.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { DateTime, InZone } from './date-time.tsx';
import { DetailAxis, DetailRow } from './detail-track.tsx';
import { FoldedChangesLane } from './folded-changes-lane.tsx';
import { GapShades } from './gap-shades.tsx';
import { LoadPlot } from './load-plot.tsx';
import { MemoryPlot } from './memory-plot.tsx';
import { MoreItems } from './more-items.tsx';
import { ProcessPlot } from './process-plot.tsx';
import { SessionRows } from './session-rows.tsx';
import { TimeAxis } from './time-axis.tsx';

const DAY_MS = 24 * 3_600_000;

type Rows = { detail: SystemDetail; window: Window };

// The agent cost per day over a long range.
function CostRow({ long, window }: { long: LongHistory; window: Window }) {
  return (
    <DetailRow label="Sessions" note="cost per day">
      <CostBars bucketMs={long.costBucketMs} costs={long.costs} height={48} window={window} />
    </DetailRow>
  );
}

// The Vitals tab up to 7 d: CPU and memory with their last sample, and the
// Conditions as spans.
function Vitals({ detail, window }: Rows) {
  const { latest } = detail;
  return (
    <>
      <DetailRow
        label="CPU busy"
        note={
          latest === undefined
            ? undefined
            : `${String(Math.round(latest.cpuBusyPercent))}% last sample`
        }
      >
        <GapShades gaps={detail.gaps} labelHeight={96} sleeps={detail.sleeps} window={window} />
        <CpuPlot buckets={detail.cpu} height={96} label="CPU busy" window={window} />
      </DetailRow>
      <DetailRow
        label="Memory"
        note={
          latest === undefined
            ? undefined
            : `${formatGiB(latest.memoryUsedBytes)} of ${formatGiB(latest.memoryTotalBytes)} GiB last sample`
        }
      >
        <MemoryPlot buckets={detail.memory} window={window} />
      </DetailRow>
      <DetailRow label="Conditions">
        <ConditionSpans conditions={detail.conditions} now={detail.now} window={window} />
      </DetailRow>
    </>
  );
}

// The Vitals tab over 30 d and 1 y: CPU, memory, and load in wider buckets
// with their bands, the agent cost per day, and the Conditions folded to one
// row per kind.
function LongVitals({ detail, range, window }: Rows & { range: LongRange }) {
  const { bucketMs, latest, long } = detail;
  return (
    <>
      <DetailRow label="CPU busy" note="avg, low–high">
        <GapShades gaps={detail.gaps} labelHeight={96} sleeps={detail.sleeps} window={window} />
        <CpuPlot
          bucketMs={bucketMs}
          buckets={detail.cpu}
          height={96}
          label="CPU busy"
          window={window}
        />
      </DetailRow>
      {long !== undefined && <CostRow long={long} window={window} />}
      <DetailRow
        label="Memory"
        note={latest === undefined ? undefined : `of ${formatGiB(latest.memoryTotalBytes)} GiB`}
      >
        <MemoryPlot band bucketMs={bucketMs} buckets={detail.memory} window={window} />
      </DetailRow>
      <DetailRow label="Load (1 min)">
        <LoadPlot band bucketMs={bucketMs} buckets={detail.load} height={56} window={window} />
      </DetailRow>
      <DetailRow label="Conditions">
        <FoldedChangesLane
          labelsInside
          binMs={CHANGE_BIN_MS[range]}
          detail={detail}
          window={window}
        />
      </DetailRow>
    </>
  );
}

// The Sessions under the Harness processes: a lane each up to 7 d, and over
// 30 d and 1 y the cost per day and how many there were.
function SessionList({ detail, window }: Rows) {
  const { long, sessions } = detail;
  if (long !== undefined) {
    return (
      <>
        <CostRow long={long} window={window} />
        <p className="py-3 text-[13px] text-muted-foreground">
          {long.sessions.toLocaleString('en-GB')} {long.sessions === 1 ? 'Session' : 'Sessions'} in
          this range. The 7 d range lists each one.
        </p>
      </>
    );
  }
  if (sessions.length === 0) {
    return <p className="py-4 text-muted-foreground">No Session in this range.</p>;
  }
  return (
    <>
      <SessionRows sessions={sessions.slice(0, 3)} system={detail.name} window={window} />
      {sessions.length > 3 && (
        <MoreItems label={`Show ${String(sessions.length - 3)} more Sessions`}>
          <SessionRows sessions={sessions.slice(3)} system={detail.name} window={window} />
        </MoreItems>
      )}
    </>
  );
}

// The Sessions tab: the Harness processes' CPU, the idle ones folded, then the
// Sessions.
function SessionsTab({ detail, window }: Rows) {
  const { active, idle } = splitIdleProcesses(detail.processes);
  return (
    <>
      <DetailRow label="Harness processes" note="CPU cores per process tree">
        <ProcessPlot bucketMs={detail.bucketMs} processes={active} window={window} />
      </DetailRow>
      {idle.length > 0 && (
        <MoreItems label={idleProcessesLabel(idle.length)}>
          <DetailRow label="Idle Harness processes">
            <ProcessPlot bucketMs={detail.bucketMs} processes={idle} window={window} />
          </DetailRow>
        </MoreItems>
      )}
      <SessionList detail={detail} window={window} />
    </>
  );
}

// The rows a tab shows at the range.
function TabRows({ detail, view, window }: Rows & { view: 'vitals' | 'sessions' }) {
  if (view === 'sessions') {
    return <SessionsTab detail={detail} window={window} />;
  }
  const { range } = detail;
  return isLongRange(range) ? (
    <LongVitals detail={detail} range={range} window={window} />
  ) : (
    <Vitals detail={detail} window={window} />
  );
}

// Each tab retains the common axis and sample selection of the original stack.
// Over 30 d and 1 y the Vitals tab draws wider buckets with their bands, the
// agent cost per day, load, and the Conditions folded to one row per kind, and
// the Sessions tab cost bars in place of a lane per Session; a pin selects a
// bucket there.
export function SystemCharts({
  bucket,
  detail,
  onSelect,
  sample,
  view,
}: {
  bucket: BucketInspection | null;
  detail: SystemDetail;
  onSelect: (t: number) => void;
  sample: SampleInspection | null;
  view: 'vitals' | 'sessions';
}) {
  const timeZone = useTimeZone();
  const window = { from: detail.from, to: detail.to };
  const selected = bucket === null ? sample?.t : bucket.t + bucket.bucketMs / 2;
  const sampleX = selected === undefined ? undefined : pinnedX(selected, window);
  return (
    <DetailAxis bucketMs={detail.bucketMs} onSelect={onSelect} selected={selected} window={window}>
      <TabRows detail={detail} view={view} window={window} />
      <TimeAxis
        ticks={timeZone === undefined ? [] : axisTicks(detail.range, window, timeZone)}
        window={window}
      >
        {selected !== undefined && sampleX !== undefined && (
          <span
            className={cn(
              'absolute -top-px rounded bg-select px-2 font-semibold whitespace-nowrap text-background',
              sampleX > 90 && '-translate-x-full',
              sampleX >= 10 && sampleX <= 90 && '-translate-x-1/2',
            )}
            style={{ left: `${String(sampleX)}%` }}
          >
            {bucket === null ? (
              <DateTime at={selected} format="clock" />
            ) : (
              <InZone>
                {(zone) =>
                  bucket.bucketMs >= DAY_MS
                    ? formatDate(bucket.t, zone)
                    : `${formatDate(bucket.t, zone)} ${formatClock(bucket.t, zone)}`
                }
              </InZone>
            )}
          </span>
        )}
      </TimeAxis>
    </DetailAxis>
  );
}
