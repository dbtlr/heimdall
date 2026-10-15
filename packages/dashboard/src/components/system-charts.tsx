import { axisTicks } from '../lib/axis.ts';
import { formatGiB } from '../lib/detail.ts';
import { inWindow, xPercent } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { cn } from '../lib/utils.ts';
import type { SampleInspection, SystemDetail } from '../server/system-detail-types.ts';
import { ConditionSpans } from './condition-spans.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { DateTime } from './date-time.tsx';
import { DetailAxis, DetailRow } from './detail-track.tsx';
import { GapShades } from './gap-shades.tsx';
import { MemoryPlot } from './memory-plot.tsx';
import { MoreItems } from './more-items.tsx';
import { ProcessPlot } from './process-plot.tsx';
import { SessionRows } from './session-rows.tsx';
import { TimeAxis } from './time-axis.tsx';

// Each tab retains the common axis and sample selection of the original stack.
export function SystemCharts({
  detail,
  onSelect,
  sample,
  view,
}: {
  detail: SystemDetail;
  onSelect: (t: number) => void;
  sample: SampleInspection | null;
  view: 'vitals' | 'sessions';
}) {
  const timeZone = useTimeZone();
  const window = { from: detail.from, to: detail.to };
  const sampleX = sample === null ? 0 : xPercent(sample.t, window);
  const { latest } = detail;
  const active = detail.processes.filter((process) =>
    process.points.some(({ cores }) => cores !== null && cores > 0),
  );
  const idle = detail.processes.filter(
    (process) => !process.points.some(({ cores }) => cores !== null && cores > 0),
  );
  return (
    <DetailAxis onSelect={onSelect} selected={sample?.t} window={window}>
      {view === 'vitals' ? (
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
      ) : (
        <>
          <DetailRow label="Harness processes" note="CPU cores per process tree">
            <ProcessPlot processes={active} window={window} />
          </DetailRow>
          {idle.length > 0 && (
            <MoreItems
              label={`${String(idle.length)} idle ${idle.length === 1 ? 'process' : 'processes'} in this range`}
            >
              <DetailRow label="Idle Harness processes">
                <ProcessPlot processes={idle} window={window} />
              </DetailRow>
            </MoreItems>
          )}
          {detail.sessions.length === 0 ? (
            <p className="py-4 text-muted-foreground">No Session in this range.</p>
          ) : (
            <>
              <SessionRows
                sessions={detail.sessions.slice(0, 3)}
                system={detail.name}
                window={window}
              />
              {detail.sessions.length > 3 && (
                <MoreItems label={`Show ${String(detail.sessions.length - 3)} more Sessions`}>
                  <SessionRows
                    sessions={detail.sessions.slice(3)}
                    system={detail.name}
                    window={window}
                  />
                </MoreItems>
              )}
            </>
          )}
        </>
      )}
      <TimeAxis
        ticks={timeZone === undefined ? [] : axisTicks(detail.range, window, timeZone)}
        window={window}
      >
        {sample !== null && inWindow(sample.t, window) && (
          <span
            className={cn(
              'absolute -top-px rounded bg-[#ffd666] px-2 font-semibold text-background',
              sampleX > 90 && '-translate-x-full',
              sampleX >= 10 && sampleX <= 90 && '-translate-x-1/2',
            )}
            style={{ left: `${String(xPercent(sample.t, window))}%` }}
          >
            <DateTime at={sample.t} format="clock" />
          </span>
        )}
      </TimeAxis>
    </DetailAxis>
  );
}
