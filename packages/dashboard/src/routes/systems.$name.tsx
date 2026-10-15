import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { AppHeader } from '../components/app-header.tsx';
import { AttentionList } from '../components/attention-list.tsx';
import { PhraseText } from '../components/date-time.tsx';
import { RangePicker } from '../components/range-picker.tsx';
import { RecordedPanel } from '../components/recorded-panel.tsx';
import { SampleInspector } from '../components/sample-inspector.tsx';
import { SampleSheet } from '../components/sample-sheet.tsx';
import { SystemCharts } from '../components/system-charts.tsx';
import { SystemFacts } from '../components/system-facts.tsx';
import { SystemGlance } from '../components/system-glance.tsx';
import { SystemNavigationHeader } from '../components/system-navigation.tsx';
import { TimelineRail } from '../components/timeline-rail.tsx';
import { UnpairedBanner } from '../components/unpaired-banner.tsx';
import { headerLine } from '../lib/detail.ts';
import { atFromSearch } from '../lib/range.ts';
import { systemSearch } from '../lib/system-search.ts';
import type { Range } from '../server/fleet-overview-types.ts';
import { getSample, getSystemDetail } from '../server/system-detail-fn.ts';
import type { SampleInspection } from '../server/system-detail-types.ts';

export const Route = createFileRoute('/systems/$name')({
  component: SystemPage,
  // Tab and sample selection reuse the loaded history; only range reloads it.
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
      <main className="mx-auto max-w-[1200px] px-3.5 py-6">
        <p>No System has that name.</p>
      </main>
    </>
  ),
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => systemSearch(search),
});

// The sample at `at`: the one the loader read, until `at` moves off it, and
// whether reading the one asked for failed.
const useSample = (
  name: string,
  at: number | undefined,
  loadedAt: number | undefined,
  loadedSample: SampleInspection | null,
) => {
  const [shown, setShown] = useState({ at: loadedAt, failed: false, name, sample: loadedSample });
  useEffect(() => {
    setShown({ at: loadedAt, failed: false, name, sample: loadedSample });
  }, [loadedAt, loadedSample, name]);
  useEffect(() => {
    if (at === shown.at && name === shown.name) {
      return undefined;
    }
    let current = true;
    const read = async () => {
      try {
        const sample = await getSample({ data: { at, name } });
        if (current) {
          setShown({ at, failed: false, name, sample });
        }
      } catch {
        if (current) {
          setShown({ at, failed: true, name, sample: null });
        }
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [at, name, shown.at, shown.name]);
  const loading = at !== shown.at || name !== shown.name;
  return {
    failed: !loading && shown.failed,
    loading,
    sample: name === shown.name ? shown.sample : null,
  };
};

function SystemPage() {
  const {
    at,
    attention,
    detail,
    navigation,
    records,
    sample: loadedSample,
  } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { failed, loading, sample } = useSample(detail.name, search.at, at, loadedSample);
  const header = headerLine(detail, detail.now);
  const charts = search.tab === 'vitals' || search.tab === 'sessions';
  const select = (t: number) => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (previous) => ({ ...previous, at: Math.round(t) }),
    });
  };
  const closeSample = () => {
    if (search.at !== undefined) {
      void navigate({
        replace: true,
        resetScroll: false,
        search: (previous) => ({ ...previous, at: undefined }),
      });
    }
  };
  return (
    <>
      <SystemNavigationHeader
        current={detail.name}
        range={detail.range}
        systems={navigation}
        tab={search.tab}
      />
      <main className="mx-auto max-w-[1200px] px-3.5 pb-8 sm:px-[22px]">
        <p className="py-3 text-sm text-muted-foreground">
          {header.lead}
          <PhraseText phrase={header.tail} />
        </p>
        {!detail.paired && <UnpairedBanner name={detail.name} />}
        {search.tab === 'now' && (
          <>
            <h2 className="mb-2 text-lg font-semibold">Open Conditions</h2>
            {attention.length === 0 ? (
              <p className="rounded-xl bg-card p-4 text-base">
                No open Condition or uncertain evidence.
              </p>
            ) : (
              <AttentionList compact items={attention} key={detail.name} now={detail.now} />
            )}
            <SystemGlance detail={detail} />
          </>
        )}
        {charts && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">
                {search.tab === 'vitals' ? 'Vitals' : 'Sessions'}
              </h2>
              <RangePicker current={detail.range} />
            </div>
            <div className="grid min-w-0 gap-4 lg:grid-cols-[1fr_290px]">
              <div className="min-w-0">
                <SystemCharts
                  detail={detail}
                  onSelect={select}
                  sample={sample}
                  view={search.tab === 'vitals' ? 'vitals' : 'sessions'}
                />
                <button
                  className="my-3 min-h-11 rounded-lg border px-3 text-base text-primary lg:hidden"
                  onClick={() => select(sample?.t ?? detail.now)}
                  type="button"
                >
                  Inspect sample
                </button>
              </div>
              <div className="hidden lg:block">
                <SampleInspector failed={failed} loading={loading} sample={sample} />
              </div>
            </div>
            {search.tab === 'vitals' && (
              <SystemFacts detail={{ ...detail, harnesses: undefined }} />
            )}
          </>
        )}
        {search.tab === 'records' && (
          <>
            <h2 className="text-lg font-semibold">Records</h2>
            {detail.harnesses !== undefined && (
              <SystemFacts detail={{ ...detail, latest: undefined }} />
            )}
            <RecordedPanel now={detail.now} recorded={records.recorded} />
          </>
        )}
        {search.tab === 'timeline' && (
          <>
            <h2 className="text-lg font-semibold">Timeline</h2>
            <TimelineRail entries={records.timeline} now={detail.now} />
          </>
        )}
      </main>
      {charts && (
        <SampleSheet
          failed={failed}
          loading={loading}
          onClose={closeSample}
          open={search.at !== undefined}
          sample={sample}
        />
      )}
    </>
  );
}
