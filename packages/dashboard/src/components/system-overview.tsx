import type { ReactNode } from 'react';

import { axisTicks } from '../lib/axis.ts';
import { LEVEL_STROKE } from '../lib/conditions.ts';
import { formatGiB } from '../lib/detail.ts';
import { inWindow, xPercent } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import type { Recorded, SampleInspection, SystemDetail } from '../server/system-detail-types.ts';
import { ChangesLane, ChangesLegend } from './changes-lane.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { DateTime } from './date-time.tsx';
import { DetailAxis, DetailTrack } from './detail-track.tsx';
import { GapShades } from './gap-shades.tsx';
import { LoadPlot } from './load-plot.tsx';
import { MemoryPlot } from './memory-plot.tsx';
import { RangePicker } from './range-picker.tsx';
import { SampleInspector } from './sample-inspector.tsx';
import { HarnessLegend, SessionLanes } from './session-lanes.tsx';
import { SystemDisks, SystemHarnesses } from './system-facts.tsx';
import { SystemMaintenanceLine } from './system-open-conditions.tsx';
import { RailConditions, RailJobs, RailServices } from './system-rail.tsx';
import { TimeAxis } from './time-axis.tsx';

// One chart of the stack: its title and what it shows, a key at the right,
// and the chart under them.
function Chart({
  aside,
  children,
  note,
  title,
}: {
  aside?: ReactNode;
  children: ReactNode;
  note?: string;
  title: string;
}) {
  return (
    <section aria-label={title} className="border-t py-3 first:border-t-0 first:pt-0">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <h2 className="text-[13px]">
          <b className="font-semibold">{title}</b>
          {note !== undefined && note !== '' && (
            <span className="text-muted-foreground"> {note}</span>
          )}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const percent = (value: number) => `${String(Math.round(value))}%`;

// What a chart's note says of its limit: the percent the Hub judges by, or
// nothing while the Hub has stored no limits.
const limitWords = (limit: number | undefined) =>
  limit === undefined ? [] : [`limit ${String(limit)}%`];

// The wide System page: one card stacking CPU busy, the agent Sessions, memory,
// load, and the Conditions and changes on one time axis, with the pinned sample
// across them; the sample's inspector, the open Conditions, Services, and jobs
// in a rail beside them; and the disks, the installed Harnesses, and the
// maintenance line under them.
export function SystemOverview({
  attention,
  detail,
  failed,
  loading,
  onSelect,
  recorded,
  sample,
}: {
  attention: readonly Attention[];
  detail: SystemDetail;
  failed: boolean;
  loading: boolean;
  onSelect: (t: number) => void;
  recorded: Recorded;
  sample: SampleInspection | null;
}) {
  const timeZone = useTimeZone();
  const window = { from: detail.from, to: detail.to };
  const sampleX = sample === null ? 0 : xPercent(sample.t, window);
  const { latest, limitPercent } = detail;
  const total = latest === undefined ? undefined : formatGiB(latest.memoryTotalBytes);
  return (
    <>
      <div className="mb-3 flex justify-end">
        <RangePicker current={detail.range} />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid min-w-0 gap-4">
          <section
            aria-label="Vitals, Sessions, and Conditions"
            className="card-surface rounded-xl border px-4 py-3.5"
          >
            <DetailAxis onSelect={onSelect} selected={sample?.t} window={window}>
              <Chart
                note={['average, low–high band', ...limitWords(limitPercent?.cpu)].join(' · ')}
                title="CPU busy"
              >
                <DetailTrack>
                  <GapShades
                    gaps={detail.gaps}
                    labelHeight={110}
                    sleeps={detail.sleeps}
                    window={window}
                  />
                  <CpuPlot
                    buckets={detail.cpu}
                    height={110}
                    label="CPU busy"
                    limits={
                      limitPercent === undefined
                        ? []
                        : [
                            {
                              color: LEVEL_STROKE.note,
                              label: `${String(limitPercent.cpu)}% limit`,
                              value: limitPercent.cpu,
                            },
                          ]
                    }
                    window={window}
                  />
                </DetailTrack>
              </Chart>
              <Chart aside={<HarnessLegend sessions={detail.sessions} />} title="Agent Sessions">
                <SessionLanes sessions={detail.sessions} system={detail.name} window={window} />
              </Chart>
              <Chart
                note={[
                  ...(total === undefined ? [] : [`of ${total} GiB`]),
                  ...limitWords(limitPercent?.memory),
                ].join(' · ')}
                title="Memory used"
              >
                <DetailTrack>
                  <MemoryPlot
                    buckets={detail.memory}
                    height={96}
                    limitPercent={limitPercent?.memory}
                    window={window}
                  />
                </DetailTrack>
              </Chart>
              {/* No line at the core count: no Collector reports one yet. */}
              <Chart title="Load (1 min)">
                <DetailTrack>
                  <LoadPlot buckets={detail.load} height={80} window={window} />
                </DetailTrack>
              </Chart>
              <Chart aside={<ChangesLegend />} title="Conditions and changes">
                <ChangesLane detail={detail} window={window} />
              </Chart>
              <TimeAxis
                bare
                ticks={timeZone === undefined ? [] : axisTicks(detail.range, window, timeZone)}
                window={window}
              >
                {sample !== null && inWindow(sample.t, window) && (
                  <span
                    className={cn(
                      'absolute -top-px rounded bg-select px-2 font-semibold text-background',
                      sampleX > 90 && '-translate-x-full',
                      sampleX >= 10 && sampleX <= 90 && '-translate-x-1/2',
                    )}
                    style={{ left: `${String(sampleX)}%` }}
                  >
                    <DateTime at={sample.t} format="clock" />
                  </span>
                )}
              </TimeAxis>
            </DetailAxis>
            {latest !== undefined && (
              <p className="sr-only">
                Last sample: CPU busy {percent(latest.cpuBusyPercent)}, memory{' '}
                {formatGiB(latest.memoryUsedBytes)} of {total} GiB.
              </p>
            )}
          </section>
          <div className="grid gap-4 md:grid-cols-2">
            <SystemDisks detail={detail} />
            <SystemHarnesses harnesses={detail.harnesses} />
          </div>
          <SystemMaintenanceLine items={attention} now={detail.now} system={detail.name} />
        </div>
        <div className="grid min-w-0 gap-4">
          <SampleInspector failed={failed} loading={loading} sample={sample} />
          <RailConditions items={attention} now={detail.now} />
          <RailServices now={detail.now} recorded={recorded} system={detail.name} />
          <RailJobs now={detail.now} recorded={recorded} />
        </div>
      </div>
    </>
  );
}
