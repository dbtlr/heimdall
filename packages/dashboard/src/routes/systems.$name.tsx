import { createFileRoute, Link } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { AppHeader } from '../components/app-header.tsx';
import { ConditionSpans } from '../components/condition-spans.tsx';
import { CpuPlot } from '../components/cpu-plot.tsx';
import { DetailAxis, DetailRow } from '../components/detail-track.tsx';
import { STATUS_COLOR } from '../components/fleet-lane.tsx';
import { GapShades } from '../components/gap-shades.tsx';
import { MemoryPlot } from '../components/memory-plot.tsx';
import { ProcessPlot } from '../components/process-plot.tsx';
import { RangePicker } from '../components/range-picker.tsx';
import { RecordedPanel } from '../components/recorded-panel.tsx';
import { SampleInspector } from '../components/sample-inspector.tsx';
import { SessionRows } from '../components/session-rows.tsx';
import { TimeAxis } from '../components/time-axis.tsx';
import { TimelineRail } from '../components/timeline-rail.tsx';
import { formatGiB, headerLine } from '../lib/detail.ts';
import { statusWord } from '../lib/lane.ts';
import { atFromSearch, rangeFromSearch } from '../lib/range.ts';
import { formatClock, inWindow, xPercent } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Range } from '../server/fleet-overview-types.ts';
import { getSample, getSystemDetail } from '../server/system-detail-fn.ts';
import type { SampleInspection } from '../server/system-detail-types.ts';

export const Route = createFileRoute('/systems/$name')({
  component: SystemPage,
  // Selecting a sample changes only `at`, so the stack is not read again; the
  // loader reads the first sample, and the page reads later ones itself.
  loader: async ({
    deps,
    location,
    params,
  }: {
    deps: { range: Range };
    location: { search: Record<string, unknown> };
    params: { name: string };
  }) => {
    const at = atFromSearch(location.search);
    const [page, sample] = await Promise.all([
      getSystemDetail({ data: { name: params.name, range: deps.range } }),
      getSample({ data: { at, name: params.name } }),
    ]);
    return { ...page, at, sample };
  },
  loaderDeps: ({ search }) => ({ range: search.range }),
  notFoundComponent: () => (
    <>
      <AppHeader />
      <main className="mx-auto max-w-[1200px] px-3.5 py-6 sm:px-[22px]">
        <p>No paired System has that name.</p>
      </main>
    </>
  ),
  validateSearch: (search: { at?: unknown; range?: unknown } & SearchSchemaInput) => ({
    at: atFromSearch(search),
    range: rangeFromSearch(search, '12h'),
  }),
});

// The sample at `at`: the one the loader read, until `at` moves off it.
const useSample = (
  name: string,
  at: number | undefined,
  loadedAt: number | undefined,
  loadedSample: SampleInspection | null,
) => {
  const [shown, setShown] = useState({ at: loadedAt, sample: loadedSample });
  useEffect(() => {
    setShown({ at: loadedAt, sample: loadedSample });
  }, [loadedAt, loadedSample]);
  useEffect(() => {
    if (at === shown.at) {
      return undefined;
    }
    let current = true;
    const read = async () => {
      const sample = await getSample({ data: { at, name } });
      if (current) {
        setShown({ at, sample });
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [at, name, shown.at]);
  return shown.sample;
};

function SystemPage() {
  const { at, detail, records, sample: loadedSample } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const sample = useSample(detail.name, search.at, at, loadedSample);
  const { latest, now, timeZone } = detail;
  const window = { from: detail.from, to: detail.to };
  const select = (t: number) => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (previous) => ({ ...previous, at: Math.round(t) }),
    });
  };
  const cpuNote =
    latest === undefined ? undefined : `${String(Math.round(latest.cpuBusyPercent))}% now`;
  const memoryNote =
    latest === undefined
      ? undefined
      : `${formatGiB(latest.memoryUsedBytes)} of ${formatGiB(latest.memoryTotalBytes)} GiB`;
  return (
    <>
      <AppHeader>
        <RangePicker current={detail.range} />
      </AppHeader>
      <main className="mx-auto max-w-[1200px] px-3.5 pb-8 sm:px-[22px]">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5 pt-3.5 pb-2 sm:pt-[18px] sm:pb-2.5">
          <h1 className="text-[19px] font-semibold sm:text-[22px]">
            <Link className="text-muted-foreground" to="/">
              Fleet
            </Link>{' '}
            / {detail.name}{' '}
            <span className={cn('ml-2 text-sm font-medium', STATUS_COLOR[detail.status])}>
              {statusWord(detail.status)}
            </span>
          </h1>
          <p className="text-muted-foreground">{headerLine(detail, { now, timeZone })}</p>
        </div>
        <div className="grid gap-x-[18px] lg:grid-cols-[1fr_290px]">
          <DetailAxis onSelect={select} selected={sample?.t} window={window}>
            <div className="min-w-0">
              <DetailRow label="CPU busy" note={cpuNote}>
                <GapShades
                  gaps={detail.gaps}
                  labelHeight={96}
                  sleeps={detail.sleeps}
                  window={window}
                />
                <CpuPlot
                  buckets={detail.cpu}
                  height={96}
                  label="CPU busy"
                  timeZone={timeZone}
                  window={window}
                />
              </DetailRow>
              <DetailRow label="Memory" note={memoryNote}>
                <MemoryPlot buckets={detail.memory} window={window} />
              </DetailRow>
              <DetailRow label="Harness processes" note="CPU cores per process tree">
                <ProcessPlot processes={detail.processes} window={window} />
              </DetailRow>
              <SessionRows sessions={detail.sessions} timeZone={timeZone} window={window} />
              <DetailRow label="Conditions">
                <ConditionSpans
                  conditions={detail.conditions}
                  now={now}
                  timeZone={timeZone}
                  window={window}
                />
              </DetailRow>
              <TimeAxis range={detail.range} timeZone={timeZone} window={window}>
                {sample !== null && inWindow(sample.t, window) && (
                  <span
                    className="absolute -top-px -translate-x-1/2 rounded-[3px] bg-[#ffd666] px-[9px] font-semibold text-background"
                    style={{ left: `${String(xPercent(sample.t, window))}%` }}
                  >
                    {formatClock(sample.t, timeZone)}
                  </span>
                )}
              </TimeAxis>
            </div>
          </DetailAxis>
          <SampleInspector sample={sample} timeZone={timeZone} />
        </div>
        <div className="grid gap-x-[18px] lg:grid-cols-[1.35fr_1fr]">
          <RecordedPanel now={now} recorded={records.recorded} timeZone={timeZone} />
          <TimelineRail entries={records.timeline} now={now} timeZone={timeZone} />
        </div>
      </main>
    </>
  );
}
