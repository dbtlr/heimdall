import type { ReactNode } from 'react';

import { axisTicks } from '../lib/axis.ts';
import { LEVEL_STROKE } from '../lib/conditions.ts';
import { formatGiB, idleProcessesLabel, splitIdleProcesses } from '../lib/detail.ts';
import { binMiddle } from '../lib/long-history.ts';
import { formatClock, formatDate, pinnedX } from '../lib/time.ts';
import type { Window } from '../lib/time.ts';
import { useTimeZone } from '../lib/use-time-zone.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import { isLongRange } from '../server/fleet-overview-types.ts';
import type {
  BucketInspection,
  Recorded,
  SampleInspection,
  SystemDetail,
} from '../server/system-detail-types.ts';
import { BucketInspector } from './bucket-inspector.tsx';
import { ChangesLane, ChangesLegend } from './changes-lane.tsx';
import { CostBars } from './cost-bars.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { DateTime, InZone } from './date-time.tsx';
import { DetailAxis, DetailTrack, SampleSlider } from './detail-track.tsx';
import { FoldedChangesLane } from './folded-changes-lane.tsx';
import { GapShades } from './gap-shades.tsx';
import { coreCountNote, LoadPlot } from './load-plot.tsx';
import { MemoryPlot } from './memory-plot.tsx';
import { MoreItems } from './more-items.tsx';
import { ProcessPlot } from './process-plot.tsx';
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
      {/* The gutter holds a plot's scale, so every chart keeps one x-extent. */}
      <div className={GUTTER}>{children}</div>
    </section>
  );
}

// The gutter's width comes from the card: wider over the long ranges, where
// the folded Conditions lane names a kind and its count in it.
const GUTTER = 'pl-[var(--chart-gutter,3.5rem)]';
const LONG_GUTTER = '7rem';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// A bucket's width as a chart note says it: "1-day buckets" or "3-hour buckets".
const bucketWords = (bucketMs: number): string =>
  bucketMs >= DAY_MS
    ? `${String(bucketMs / DAY_MS)}-day buckets`
    : `${String(bucketMs / HOUR_MS)}-hour buckets`;

// The range in words for a count over it.
const RANGE_PLACE = { '1y': 'the year', '30d': '30 days' } as const;

const percent = (value: number) => `${String(Math.round(value))}%`;

// What a chart's note says of its limit: the percent the Hub judges by, or
// nothing while the Hub has stored no limits.
const limitWords = (limit: number | undefined) =>
  limit === undefined ? [] : [`limit ${String(limit)}%`];

// The System's Harness process plots, closed until asked for: CPU cores per
// process tree for the busy ones, then the idle ones folded under them, as on
// the phone. Each plot keeps the gutter, so it stays on the shared axis. With
// no Harness process in the window, there is nothing to disclose.
function HarnessProcesses({
  bucketMs,
  edges,
  processes,
  window,
}: {
  bucketMs: number;
  edges: SystemDetail['edges'];
  processes: SystemDetail['processes'];
  window: Window;
}) {
  if (processes.length === 0) {
    return null;
  }
  const { active, idle } = splitIdleProcesses(processes);
  return (
    <MoreItems label="Harness processes" scrolls={false}>
      <section aria-label="Harness processes" className={cn(GUTTER, 'pt-1')}>
        <p className="mb-1.5 text-[13px] text-muted-foreground">
          CPU cores per process tree
          {bucketMs > 5 * 60_000 && `, ${bucketWords(bucketMs)}, from 5-minute rollups`}
        </p>
        <DetailTrack>
          <ProcessPlot
            bucketMs={bucketMs}
            edges={edges}
            processes={active}
            scaleBeside
            window={window}
          />
        </DetailTrack>
      </section>
      {idle.length > 0 && (
        <MoreItems label={idleProcessesLabel(idle.length)} scrolls={false}>
          <div className={cn(GUTTER, 'pt-1')}>
            <DetailTrack>
              <ProcessPlot
                bucketMs={bucketMs}
                edges={edges}
                processes={idle}
                scaleBeside
                window={window}
              />
            </DetailTrack>
          </div>
        </MoreItems>
      )}
    </MoreItems>
  );
}

// The wide System page: one card stacking CPU busy, the agent Sessions, memory,
// load, and the Conditions and changes on one time axis, with the pinned sample
// across them; the sample's inspector, the open Conditions, Services, and jobs
// in a rail beside them; and the disks, the installed Harnesses, and the
// maintenance line under them. Over 30 d and 1 y the charts draw wider buckets
// with their low–high bands, the Sessions as cost bars, and the Conditions
// folded to one row per kind, and the inspector shows the pinned bucket.
export function SystemOverview({
  at,
  attention,
  bucket,
  detail,
  failed,
  loading,
  onSelect,
  recorded,
  sample,
}: {
  // The pinned time the route holds, which `sample` is the stored one nearest.
  at: number | undefined;
  attention: readonly Attention[];
  // The pinned bucket over 30 d and 1 y, in place of `sample`.
  bucket: BucketInspection | null;
  detail: SystemDetail;
  failed: boolean;
  loading: boolean;
  onSelect: (t: number) => void;
  recorded: Recorded;
  sample: SampleInspection | null;
}) {
  const timeZone = useTimeZone();
  const window = { from: detail.from, to: detail.to };
  const { bucketMs, edges, latest, limitPercent, long, range } = detail;
  const longRange = isLongRange(range) ? range : undefined;
  const banded = longRange === undefined ? [] : ['average, low–high band'];
  // The pinned bucket's middle, or the pinned sample.
  const selected = bucket === null ? sample?.t : binMiddle(bucket, window);
  const sampleX = selected === undefined ? undefined : pinnedX(selected, window);
  const total = latest === undefined ? undefined : formatGiB(latest.memoryTotalBytes);
  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="grid min-w-0 gap-4">
          <section
            aria-label="Vitals, Sessions, and Conditions"
            className="card-surface rounded-xl border px-4 py-3.5"
            style={
              longRange === undefined ? undefined : { ['--chart-gutter' as string]: LONG_GUTTER }
            }
          >
            <DetailAxis
              at={at}
              bucketMs={bucketMs}
              onSelect={onSelect}
              selected={selected}
              window={window}
            >
              <Chart
                note={[
                  'average, low–high band',
                  ...(longRange === undefined ? [] : [bucketWords(bucketMs)]),
                  ...limitWords(limitPercent?.cpu),
                ].join(' · ')}
                title="CPU busy"
              >
                <DetailTrack>
                  <GapShades
                    gaps={detail.gaps}
                    labelHeight={140}
                    sleeps={detail.sleeps}
                    window={window}
                  />
                  <CpuPlot
                    scaleBeside
                    bucketMs={bucketMs}
                    buckets={detail.cpu}
                    edges={edges}
                    height={140}
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
              {long === undefined || longRange === undefined ? (
                <Chart aside={<HarnessLegend sessions={detail.sessions} />} title="Agent Sessions">
                  <SessionLanes sessions={detail.sessions} system={detail.name} window={window} />
                </Chart>
              ) : (
                <Chart
                  aside={<HarnessLegend sessions={long.costs} />}
                  note={`list-price cost per day · ${long.sessions.toLocaleString('en-GB')} ${long.sessions === 1 ? 'Session' : 'Sessions'} in ${RANGE_PLACE[longRange]}`}
                  title="Agent Sessions"
                >
                  <CostBars scaleBeside costs={long.costs} edges={long.dayEdges} window={window} />
                </Chart>
              )}
              <HarnessProcesses
                bucketMs={bucketMs}
                edges={edges}
                processes={detail.processes}
                window={window}
              />
              <Chart
                note={[
                  ...(total === undefined ? [] : [`of ${total} GiB`]),
                  ...banded,
                  ...limitWords(limitPercent?.memory),
                ].join(' · ')}
                title="Memory used"
              >
                <DetailTrack>
                  <MemoryPlot
                    scaleBeside
                    band={longRange !== undefined}
                    bucketMs={bucketMs}
                    buckets={detail.memory}
                    edges={edges}
                    height={110}
                    limitPercent={limitPercent?.memory}
                    window={window}
                  />
                </DetailTrack>
              </Chart>
              <Chart
                note={[
                  ...(detail.cpuCores === undefined ? [] : [coreCountNote(detail.cpuCores)]),
                  ...banded,
                ].join(' · ')}
                title="Load (1 min)"
              >
                <DetailTrack>
                  <LoadPlot
                    scaleBeside
                    band={longRange !== undefined}
                    bucketMs={bucketMs}
                    cores={detail.cpuCores}
                    edges={edges}
                    buckets={detail.load}
                    height={80}
                    window={window}
                  />
                </DetailTrack>
              </Chart>
              {longRange === undefined ? (
                <Chart aside={<ChangesLegend />} title="Conditions and changes">
                  <ChangesLane detail={detail} window={window} />
                </Chart>
              ) : (
                <Chart
                  aside={<ChangesLegend reboots />}
                  note={`one row per kind · changes per ${longRange === '1y' ? 'week' : 'day'}`}
                  title="Conditions and changes"
                >
                  <FoldedChangesLane detail={detail} window={window} />
                </Chart>
              )}
              <div className={GUTTER}>
                <SampleSlider>
                  <TimeAxis
                    bare
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
                </SampleSlider>
              </div>
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
          {longRange === undefined ? (
            <SampleInspector failed={failed} loading={loading} sample={sample} />
          ) : (
            <BucketInspector bucket={bucket} failed={failed} loading={loading} />
          )}
          <RailConditions items={attention} now={detail.now} />
          <RailServices now={detail.now} recorded={recorded} system={detail.name} />
          <RailJobs now={detail.now} recorded={recorded} />
        </div>
      </div>
    </>
  );
}
