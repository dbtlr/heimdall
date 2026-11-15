import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { BucketInspector } from '../components/bucket-inspector.tsx';
import { PhraseText } from '../components/date-time.tsx';
import { RangePicker } from '../components/range-picker.tsx';
import { RecordedPanel } from '../components/recorded-panel.tsx';
import { SampleInspector } from '../components/sample-inspector.tsx';
import { SampleSheet } from '../components/sample-sheet.tsx';
import { SilenceBanner } from '../components/silence-line.tsx';
import { SystemActivity } from '../components/system-activity.tsx';
import { SystemCharts } from '../components/system-charts.tsx';
import { SystemFacts } from '../components/system-facts.tsx';
import { SystemGlance } from '../components/system-glance.tsx';
import { SystemNavigationHeader } from '../components/system-navigation.tsx';
import { SystemMaintenance, SystemOpenConditions } from '../components/system-open-conditions.tsx';
import { SystemOverview } from '../components/system-overview.tsx';
import { UnpairedBanner } from '../components/unpaired-banner.tsx';
import { headerLine } from '../lib/detail.ts';
import { contentFrame } from '../lib/layout.ts';
import { atFromSearch } from '../lib/range.ts';
import { desktopTab, systemSearch } from '../lib/system-search.ts';
import { isLongRange } from '../server/fleet-overview-types.ts';
import type { Range } from '../server/fleet-overview-types.ts';
import { getBucket, getSample, getSystemDetail } from '../server/system-detail-fn.ts';
import type { BucketInspection, SampleInspection } from '../server/system-detail-types.ts';

// What the inspector shows: the sample nearest the pinned time up to 7 d, and
// over 30 d and 1 y the bucket holding it, since raw samples end at 14 days.
type Inspected = { bucket: BucketInspection | null; sample: SampleInspection | null };

const NOTHING: Inspected = { bucket: null, sample: null };

const readInspected = async (
  name: string,
  at: number | undefined,
  range: Range,
): Promise<Inspected> =>
  isLongRange(range)
    ? { bucket: await getBucket({ data: { at, name, range } }), sample: null }
    : { bucket: null, sample: await getSample({ data: { at, name } }) };

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
    const [page, inspected] = await Promise.all([
      getSystemDetail({ data: { name: params.name, range: deps.range } }),
      readInspected(params.name, at, deps.range),
    ]);
    return { ...page, at, inspected };
  },
  loaderDeps: ({ search }) => ({ range: search.range }),
  notFoundComponent: () => (
    <>
      <main className={`${contentFrame('wide', true)} py-6`}>
        <p>No System has that name.</p>
      </main>
    </>
  ),
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) => systemSearch(search),
});

// The sample or bucket at `at`: the one the loader read, until `at` moves off
// it, and whether reading the one asked for failed. `range` is the loaded
// range, which decides which of the two is read.
const useInspected = (
  name: string,
  range: Range,
  at: number | undefined,
  loadedAt: number | undefined,
  loaded: Inspected,
) => {
  const [shown, setShown] = useState({ at: loadedAt, failed: false, inspected: loaded, name });
  useEffect(() => {
    setShown({ at: loadedAt, failed: false, inspected: loaded, name });
  }, [loadedAt, loaded, name]);
  useEffect(() => {
    if (at === shown.at && name === shown.name) {
      return undefined;
    }
    let current = true;
    const read = async () => {
      try {
        const inspected = await readInspected(name, at, range);
        if (current) {
          setShown({ at, failed: false, inspected, name });
        }
      } catch {
        if (current) {
          setShown({ at, failed: true, inspected: NOTHING, name });
        }
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [at, name, range, shown.at, shown.name]);
  const loading = at !== shown.at || name !== shown.name;
  return {
    failed: !loading && shown.failed,
    inspected: name === shown.name ? shown.inspected : NOTHING,
    loading,
  };
};

function SystemPage() {
  const {
    activity,
    at,
    attention,
    detail,
    navigation,
    records,
    inspected: loadedInspected,
  } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { failed, inspected, loading } = useInspected(
    detail.name,
    detail.range,
    search.at,
    at,
    loadedInspected,
  );
  const { bucket, sample } = inspected;
  const header = headerLine(detail, detail.now);
  const charts = search.tab === 'vitals' || search.tab === 'sessions';
  const overview = desktopTab(search.tab) === 'overview';
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
      <main className={`${contentFrame('wide')} pb-8`}>
        <p className="py-3 text-sm text-muted-foreground">
          {header.lead}
          <PhraseText phrase={header.tail} />
        </p>
        {!detail.paired && <UnpairedBanner name={detail.name} />}
        <SilenceBanner now={detail.now} until={detail.silencedUntil} />
        {overview && (
          <div className="hidden lg:block">
            <SystemOverview
              at={search.at}
              attention={attention}
              bucket={bucket}
              detail={detail}
              failed={failed}
              loading={loading}
              onSelect={select}
              recorded={records.recorded}
              sample={sample}
            />
          </div>
        )}
        {/* The phone keeps the Now, Vitals, and Sessions tabs; a wide screen has the Overview. */}
        {search.tab === 'now' && (
          <div className="lg:hidden">
            <SystemOpenConditions items={attention} key={detail.name} now={detail.now} />
            <SystemMaintenance items={attention} now={detail.now} />
            <SystemGlance detail={detail} />
          </div>
        )}
        {charts && (
          <div className="lg:hidden">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold">
                {search.tab === 'vitals' ? 'Vitals' : 'Sessions'}
              </h2>
              <RangePicker current={detail.range} />
            </div>
            <div className="min-w-0">
              <SystemCharts
                bucket={bucket}
                detail={detail}
                onSelect={select}
                sample={sample}
                view={search.tab === 'vitals' ? 'vitals' : 'sessions'}
              />
              <button
                className="my-3 min-h-11 rounded-lg border px-3 text-base text-primary"
                onClick={() => select(bucket?.t ?? sample?.t ?? detail.now)}
                type="button"
              >
                {detail.long === undefined ? 'Inspect sample' : 'Inspect bucket'}
              </button>
            </div>
            {search.tab === 'vitals' && (
              <SystemFacts detail={{ ...detail, harnesses: undefined }} />
            )}
          </div>
        )}
        {search.tab === 'records' && (
          <>
            <h2 className="text-lg font-semibold">Records</h2>
            {detail.harnesses !== undefined && (
              <SystemFacts detail={{ ...detail, latest: undefined }} />
            )}
            <RecordedPanel now={detail.now} recorded={records.recorded} system={detail.name} />
          </>
        )}
        {search.tab === 'activity' && <SystemActivity activity={activity} system={detail.name} />}
      </main>
      {overview && (
        <SampleSheet
          onClose={closeSample}
          open={search.at !== undefined}
          title={detail.long === undefined ? 'Vitals sample' : 'Vitals bucket'}
        >
          {detail.long === undefined ? (
            <SampleInspector failed={failed} loading={loading} sample={sample} />
          ) : (
            <BucketInspector bucket={bucket} failed={failed} loading={loading} />
          )}
        </SampleSheet>
      )}
    </>
  );
}
