import type { ConditionLevel } from '@heimdall/schema';
import { Link } from '@tanstack/react-router';
import { BellOff, Moon } from 'lucide-react';

import { laneSummary } from '../lib/attention.ts';
import { diskUsage, fullestDisk } from '../lib/facts.ts';
import { meterLevels } from '../lib/fleet-tile.ts';
import type { SystemTile } from '../lib/fleet-tile.ts';
import { formatSpanShort } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import type { Lane } from '../server/fleet-overview-types.ts';
import {
  AttentionStatus,
  MARK_COLOR,
  namedItem,
  STATUS_COLOR,
  UnconfirmedPill,
} from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { silenceLeft } from './silence-line.tsx';

// A meter's bar fill: the glyph color of the level, else a neutral blue-grey.
const FILL_COLOR: Record<ConditionLevel, string> = {
  alert: 'bg-status-critical',
  note: 'bg-status-warning',
  warning: 'bg-status-serious',
};

// One resource on a tile: its label, a thin bar filled to the percent, and the
// rounded percent. A level from an open Condition on the resource colors both;
// an unknown percent reads as a dash with an empty bar.
function Meter({
  label,
  level,
  percent,
}: {
  label: string;
  level: ConditionLevel | undefined;
  percent: number | undefined;
}) {
  const filled = Math.min(100, Math.max(0, percent ?? 0));
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={percent === undefined ? undefined : Math.round(percent)}
      className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-1.5 text-xs text-muted-foreground"
      role="meter"
    >
      <span>{label}</span>
      <span aria-hidden="true" className="h-1.5 rounded-full bg-border">
        <span
          className={cn(
            'block h-full rounded-full',
            level === undefined ? 'bg-[#6f8fc4]' : FILL_COLOR[level],
          )}
          style={{ width: `${String(filled)}%` }}
        />
      </span>
      <span
        className={cn('text-right', level === undefined ? 'text-foreground/80' : MARK_COLOR[level])}
      >
        {percent === undefined ? '—' : `${String(Math.round(percent))}%`}
      </span>
    </div>
  );
}

// The CPU, Mem, and fullest Disk meters from the newest Vitals sample, or a
// short line when none has arrived.
function TileMeters({ tile }: { tile: SystemTile }) {
  const { latest } = tile.lane;
  if (latest === undefined) {
    return <p className="text-xs text-muted-foreground">No Vitals yet</p>;
  }
  const levels = meterLevels(tile.items);
  const disk = fullestDisk(latest.disks);
  return (
    <>
      <Meter label="CPU" level={levels.cpu} percent={latest.cpuBusyPercent} />
      <Meter label="Mem" level={levels.memory} percent={latest.memoryUsedPercent} />
      <Meter
        label="Disk"
        level={levels.disk}
        percent={disk === undefined ? undefined : diskUsage(disk).percent}
      />
    </>
  );
}

// The System's worst alert or warning with its subject and the count of the
// others, then the dashed pill for evidence that does not confirm a failure.
// Nothing for a System with neither; an unpaired one lists its items in Open now.
function TileCondition({ tile }: { tile: SystemTile }) {
  const { items, lane } = tile;
  const named = namedItem(items, lane.status);
  const { unconfirmed } = laneSummary(items);
  if (named !== undefined) {
    return (
      <p className="text-[13.5px] leading-tight wrap-anywhere">
        <AttentionStatus items={items} showSubject status={lane.status} />
      </p>
    );
  }
  return unconfirmed === 0 || lane.status === 'unpaired' ? null : (
    <p className="text-[13.5px] leading-tight">
      <UnconfirmedPill count={unconfirmed} plus={false} />
    </p>
  );
}

// The status slot: the worst alert or warning, else asleep as a moon, else the
// healthy circle for an up System and an unknown ring for one never seen or unpaired.
function StatusSlot({ lane, tile }: { lane: Lane; tile: SystemTile }) {
  if (tile.level === undefined && tile.asleep) {
    return (
      <span aria-label="Asleep" className="flex-none text-muted-foreground" role="img">
        <Moon aria-hidden="true" className="size-3" />
      </span>
    );
  }
  return (
    <ConditionGlyph
      kind={
        tile.level ??
        (lane.status === 'never_seen' || lane.status === 'unpaired' ? 'unknown' : 'cleared')
      }
    />
  );
}

// The tile's top-right: the time left on a silence with a crossed-out bell, else
// the short time since Last seen, a dash when never seen.
function TileCorner({ lane, now }: { lane: Lane; now: number }) {
  if (lane.silencedUntil !== undefined) {
    const left = silenceLeft(now, lane.silencedUntil);
    return (
      <span
        aria-label={`Alerts silenced, ${left} left`}
        className="inline-flex flex-none items-center gap-1 text-xs whitespace-nowrap text-muted-foreground"
        role="img"
      >
        <BellOff aria-hidden="true" className="size-3" />
        {left}
      </span>
    );
  }
  return (
    <span className="flex-none text-xs whitespace-nowrap text-muted-foreground">
      {lane.lastSeenAt === undefined ? '—' : formatSpanShort(now - lane.lastSeenAt)}
    </span>
  );
}

// The Systems as tiles, in the order given: each links to its System and shows
// its health, Vitals meters, and worst open Condition.
export function FleetTiles({ now, tiles }: { now: number; tiles: readonly SystemTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
      {tiles.map((tile) => (
        <Link
          className={cn(
            'flex min-w-0 flex-col gap-1 rounded-xl border bg-card px-2.5 py-2 hover:border-muted-foreground',
            tile.level === 'alert' && 'border-status-critical/75',
            tile.level === 'warning' && 'border-status-serious/60',
            (tile.asleep || tile.lane.status === 'unpaired') && 'bg-muted/30',
          )}
          key={tile.lane.name}
          params={{ name: tile.lane.name }}
          to="/systems/$name"
        >
          <div className="flex items-center gap-1.5">
            <h3
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 text-[17px] font-semibold break-all',
                tile.asleep && 'text-muted-foreground',
              )}
            >
              <StatusSlot lane={tile.lane} tile={tile} />
              {tile.lane.name}
            </h3>
            <TileCorner lane={tile.lane} now={now} />
          </div>
          {tile.lane.status === 'unpaired' && (
            <span className={cn('self-start text-xs', STATUS_COLOR.unpaired)}>Unpaired</span>
          )}
          <TileMeters tile={tile} />
          <TileCondition tile={tile} />
        </Link>
      ))}
    </div>
  );
}
