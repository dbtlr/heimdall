import { Link } from '@tanstack/react-router';

import { isAsleep, levelCounts, levelCountsText, worstActionLevel } from '../lib/fleet.ts';
import type { Window } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Attention } from '../server/attention-types.ts';
import type { Lane, Range } from '../server/fleet-overview-types.ts';
import { MARK_COLOR } from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { CpuPlot } from './cpu-plot.tsx';
import { DateTime } from './date-time.tsx';
import { FleetSystemVitals } from './fleet-system-vitals.tsx';
import { SilenceLine } from './silence-line.tsx';

export function FleetSystems({
  lanes,
  attention,
  now,
  range,
  window,
}: {
  lanes: readonly Lane[];
  attention: readonly Attention[];
  now: number;
  range: Range;
  window: Window;
}) {
  const systems = lanes
    .map((lane) => {
      const counts = levelCounts(attention.filter((item) => item.system === lane.name));
      const level = worstActionLevel(counts);
      return { asleep: isAsleep(lane, now), counts, lane, level };
    })
    .toSorted(
      (a, b) =>
        Number(b.counts.alert > 0) - Number(a.counts.alert > 0) ||
        Number(b.counts.warning > 0) - Number(a.counts.warning > 0) ||
        Number(a.asleep) - Number(b.asleep) ||
        a.lane.name.localeCompare(b.lane.name),
    );
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {systems.map(({ lane, counts, level, asleep }) => (
        <Link
          className={cn(
            'min-w-0 rounded-xl border bg-card p-4 hover:border-muted-foreground',
            (asleep || lane.status === 'unpaired') && 'bg-muted/30',
          )}
          key={lane.name}
          params={{ name: lane.name }}
          to="/systems/$name"
        >
          <h3
            className={cn(
              'flex items-center gap-2 text-xl font-semibold break-all',
              asleep && 'text-muted-foreground',
            )}
          >
            <ConditionGlyph
              kind={
                level ??
                (asleep || lane.status === 'never_seen' || lane.status === 'unpaired'
                  ? 'unknown'
                  : 'cleared')
              }
            />
            {lane.name}
          </h3>
          <p
            className={cn(
              'mt-1 text-base',
              level === undefined ? 'text-muted-foreground' : MARK_COLOR[level],
            )}
          >
            {levelCountsText(counts) || 'No open Conditions'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {lane.status === 'unpaired' && 'Unpaired · '}
            {asleep && 'Asleep · '}
            {lane.lastSeenAt === undefined ? (
              'Never seen'
            ) : (
              <>
                Last seen <DateTime at={lane.lastSeenAt} format="when" now={now} />
              </>
            )}
          </p>
          <SilenceLine now={now} until={lane.silencedUntil} />
          <FleetSystemVitals latest={lane.latest} now={now} />
          {lane.buckets.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">No CPU samples in this period.</p>
          ) : (
            <CpuPlot
              buckets={lane.buckets}
              height={56}
              label={`${lane.name} CPU, 0–100%`}
              window={window}
            />
          )}
          <p className="mt-1 flex flex-wrap justify-between gap-x-3 text-sm text-muted-foreground">
            <span>CPU over {range} · 0–100%</span>
            <span>5-minute average</span>
          </p>
        </Link>
      ))}
    </div>
  );
}
