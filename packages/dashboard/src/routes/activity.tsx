import { createFileRoute } from '@tanstack/react-router';
import type { SearchSchemaInput } from '@tanstack/react-router';
import { useEffect, useState } from 'react';

import { ActivityAxis } from '../components/activity-axis.tsx';
import { ActivityRangePicker, KindChips, SystemSelect } from '../components/activity-filters.tsx';
import { ActivityList } from '../components/activity-list.tsx';
import type { Pin } from '../components/activity-list.tsx';
import { PinnedMomentCard } from '../components/pinned-moment.tsx';
import type { MomentRead } from '../components/pinned-moment.tsx';
import { pinWithin } from '../lib/activity-moment.ts';
import { activityCounts, activitySearch, filterActivity, groupActivity } from '../lib/activity.ts';
import { contentFrame } from '../lib/layout.ts';
import { getActivity } from '../server/activity-fn.ts';
import type { ActivityRange } from '../server/activity-types.ts';
import { getPinnedMoment } from '../server/pinned-moment-fn.ts';

export const Route = createFileRoute('/activity')({
  component: ActivityPage,
  // Annotated, because Router infers `deps` only from a `loaderDeps` written first, which key order forbids.
  loader: ({ deps }: { deps: { range: ActivityRange } }) => getActivity({ data: deps }),
  loaderDeps: ({ search }) => ({ range: search.range }),
  validateSearch: (
    search: { kind?: unknown; range?: unknown; system?: unknown } & SearchSchemaInput,
  ) => activitySearch(search),
});

// What the pinned moment holds, read when the pin moves; undefined pin reads nothing.
const useMomentRead = (pin: Pin | undefined): MomentRead => {
  const [read, setRead] = useState<{ key: string; result: MomentRead } | undefined>();
  const key = pin === undefined ? undefined : `${String(pin.at)}@${pin.system ?? ''}`;
  useEffect(() => {
    if (pin === undefined || key === undefined) {
      return undefined;
    }
    let current = true;
    const load = async () => {
      try {
        const moment = await getPinnedMoment({ data: pin });
        if (current) {
          setRead({ key, result: { moment, state: 'ready' } });
        }
      } catch {
        if (current) {
          setRead({ key, result: { state: 'failed' } });
        }
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [key, pin?.at, pin?.system]);
  return read !== undefined && read.key === key ? read.result : { state: 'loading' };
};

function ActivityPage() {
  const { bucketMs, events, from, lanes, now, range, unpaired } = Route.useLoaderData();
  const { kind, pin: pinAt, pinOn, system } = Route.useSearch();
  const navigate = Route.useNavigate();
  const filters = { kind, system };
  const shown = filterActivity(events, filters);
  const lines = groupActivity(shown);
  const counts = activityCounts(events, filters);
  const unpairedSystems = new Set(unpaired);
  // A pin off the range's axis, from an old link or a longer range, is none.
  const pin = pinWithin<Pin>(pinAt === undefined ? undefined : { at: pinAt, system: pinOn }, {
    from,
    to: now,
  });
  const setPin = (next: Pin | undefined) => {
    void navigate({
      replace: true,
      resetScroll: false,
      search: (previous) => ({ ...previous, pin: next?.at, pinOn: next?.system }),
    });
  };
  const read = useMomentRead(pin);
  // The axis keeps a lane for each System the filter leaves, and a mark for
  // each change it leaves, of every kind the list shows.
  const shownLanes = lanes.filter((lane) => system === undefined || lane.system === system);
  return (
    <main className={`${contentFrame('wide')} py-5`}>
      <header>
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="mt-1 text-base text-muted-foreground">
          What changed across the fleet on one time axis, then newest first. Changes on one System
          within 2 minutes share a line.
        </p>
      </header>
      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        <KindChips
          counts={counts.kind}
          current={kind}
          total={Object.values(counts.kind).reduce((sum, count) => sum + count, 0)}
        />
        <SystemSelect
          counts={counts.system}
          current={system}
          onChange={(next) => {
            void navigate({
              resetScroll: false,
              search: (previous) => ({ ...previous, system: next }),
            });
          }}
          unpaired={unpairedSystems}
        />
        <div className="sm:ml-auto">
          <ActivityRangePicker current={range} />
        </div>
      </div>
      {shownLanes.length > 0 && (
        <section
          aria-label="Shared time axis"
          className="card-surface mt-4 rounded-xl border px-4 py-3"
        >
          <ActivityAxis
            bucketMs={bucketMs}
            lanes={shownLanes}
            lines={lines}
            onPin={setPin}
            pin={pin}
            window={{ from, to: now }}
          />
        </section>
      )}
      <PinnedMomentCard
        events={shown}
        now={now}
        onClear={() => {
          setPin(undefined);
        }}
        pin={pin}
        read={read}
      />
      <section aria-label="Changes" className="card-surface mt-3 rounded-xl border px-4 py-4">
        {lines.length === 0 ? (
          <p aria-live="polite" className="text-muted-foreground">
            {events.length === 0
              ? 'Nothing changed in this range.'
              : 'No change matches these filters.'}
          </p>
        ) : (
          <ActivityList
            lines={lines}
            now={now}
            onPick={(line) => {
              setPin({ at: line.at, system: line.system });
            }}
            pinned={pin}
            unpaired={unpairedSystems}
          />
        )}
      </section>
    </main>
  );
}
