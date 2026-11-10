import type { ConditionLevel } from '@heimdall/schema';
import { Link } from '@tanstack/react-router';
import { BellOff, Moon } from 'lucide-react';

import { laneSummary } from '../lib/attention.ts';
import { LEVEL_STROKE } from '../lib/conditions.ts';
import { diskReading, meterLevels, tileStatusWords } from '../lib/fleet-tile.ts';
import type { SystemTile } from '../lib/fleet-tile.ts';
import { runningChip } from '../lib/home-agents.ts';
import { ownHarnessColor } from '../lib/lane.ts';
import { sparklineAreaPath, sparklinePath } from '../lib/sparkline.ts';
import { formatSpanShort, silenceLeft } from '../lib/time.ts';
import { cn } from '../lib/utils.ts';
import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type { SystemGlance } from '../server/fleet-overview-types.ts';
import type { TileGlance } from '../server/home-types.ts';
import type { SessionKey } from '../server/session-view-types.ts';
import {
  AttentionStatus,
  MARK_COLOR,
  namedItem,
  STATUS_COLOR,
  UnconfirmedPill,
} from './attention-status.tsx';
import { ConditionGlyph } from './condition-glyph.tsx';
import { PLOT_COLOR, PlotGradient, usePlotGradientId } from './plot-scale.tsx';

// A meter's bar fill: the glyph color of the level, else a neutral blue-grey.
const FILL_COLOR: Record<ConditionLevel, string> = {
  alert: 'bg-status-critical',
  note: 'bg-status-warning',
  warning: 'bg-status-serious',
};

const METER_LAYOUT =
  'grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-center gap-1.5 text-xs text-muted-foreground tabular-nums';

// One resource on a tile: its label, a thin bar filled to the percent, and the
// rounded percent. A level from an open Condition on the resource colors both
// and is also said in words. An unknown percent reads as a dash with an empty
// bar and is labelled unknown rather than given a meter role. `mount` names the
// disk the percent is of.
function Meter({
  label,
  level,
  mount,
  percent,
}: {
  label: string;
  level: ConditionLevel | undefined;
  mount?: string | undefined;
  percent: number | undefined;
}) {
  const rounded = percent === undefined ? undefined : Math.round(percent);
  const parts = (
    <>
      <span title={mount}>
        {label}
        {mount !== undefined && <span className="sr-only"> {mount}</span>}
      </span>
      <span aria-hidden="true" className="h-1.5 rounded-full bg-border">
        <span
          className={cn(
            'block h-full rounded-full',
            level === undefined ? 'bg-plot' : FILL_COLOR[level],
          )}
          style={{ width: `${String(Math.min(100, Math.max(0, percent ?? 0)))}%` }}
        />
      </span>
      <span
        className={cn('text-right', level === undefined ? 'text-foreground/80' : MARK_COLOR[level])}
      >
        {rounded === undefined ? '—' : `${String(rounded)}%`}
      </span>
    </>
  );
  if (rounded === undefined) {
    return (
      <div aria-label={`${label} unknown`} className={METER_LAYOUT} role="img">
        {parts}
      </div>
    );
  }
  const reading = `${mount === undefined ? label : `${label} ${mount}`} ${String(rounded)}%`;
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={rounded}
      aria-valuetext={level === undefined ? reading : `${reading}, ${level}`}
      className={METER_LAYOUT}
      role="meter"
    >
      {parts}
    </div>
  );
}

// The Mem and Disk meters from the newest Vitals sample, or a short line when
// none has arrived. A sample older than QUIET_AFTER_MS is muted and dated for
// screen readers, so its values do not read as current.
function TileMeters({ now, tile }: { now: number; tile: SystemTile }) {
  const { latest } = tile.lane;
  if (latest === undefined) {
    return <p className="text-xs text-muted-foreground">No Vitals yet</p>;
  }
  const levels = meterLevels(tile.items);
  const disk = diskReading(latest.disks, tile.items);
  const stale = now - latest.t > QUIET_AFTER_MS;
  return (
    <div className={cn('flex flex-col gap-1', stale && 'opacity-50')}>
      {stale && <span className="sr-only">Vitals as of {formatSpanShort(now - latest.t)} ago</span>}
      <Meter label="Mem" level={levels.memory} percent={latest.memoryUsedPercent} />
      <Meter label="Disk" level={levels.disk} mount={disk?.mount} percent={disk?.percent} />
    </div>
  );
}

const SPARK_WIDTH = 100;
const SPARK_HEIGHT = 26;

// The System's CPU busy over the last day, one point per 5-minute bucket, its
// line and fill from the shared plot primitives in its worst level's color, a
// gap in the Vitals breaking the line. No scale at this size: the label says
// what it is, with the newest reading.
function TileSparkline({
  from,
  now,
  tile,
}: {
  from: number;
  now: number;
  tile: SystemTile<TileGlance>;
}) {
  const fill = usePlotGradientId();
  const { cpu, gaps, latest } = tile.lane;
  const color = tile.level === undefined ? PLOT_COLOR : LEVEL_STROKE[tile.level];
  const points = cpu.map(({ average, t }) => ({ t, value: average }));
  const box = { ceiling: 100, from, height: SPARK_HEIGHT, to: now, width: SPARK_WIDTH };
  const label = `CPU over the last 24 h${latest === undefined ? '' : `, ${String(Math.round(latest.cpuBusyPercent))}% at the newest sample`}`;
  return (
    <div
      aria-label={label}
      className={cn('relative my-1 h-[26px] w-full', tile.asleep && 'opacity-60')}
      role="img"
    >
      <PlotGradient color={color} id={fill} />
      <svg
        aria-hidden="true"
        className="block size-full overflow-visible"
        preserveAspectRatio="none"
        viewBox={`0 0 ${String(SPARK_WIDTH)} ${String(SPARK_HEIGHT)}`}
      >
        <path d={sparklineAreaPath(points, gaps, box)} fill={`url(#${fill})`} />
        <path
          d={sparklinePath(points, gaps, box)}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.25}
          style={{ vectorEffect: 'non-scaling-stroke' }}
        />
      </svg>
    </div>
  );
}

// What the System's state is in words: its worst alert or warning with its
// subject and the count of the others, else "Healthy", "Asleep 20 h", "No
// Report yet", or "Unpaired", then the dashed pill for evidence that does not
// confirm a failure. An unpaired System lists its items on Compare instead.
function TileStatus({ now, tile }: { now: number; tile: SystemTile }) {
  const { items, lane } = tile;
  if (namedItem(items, lane.status) !== undefined) {
    return (
      <p className="text-[13px] leading-tight wrap-anywhere">
        <AttentionStatus items={items} showSubject status={lane.status} />
      </p>
    );
  }
  const { unconfirmed } = laneSummary(items);
  const unpaired = lane.status === 'unpaired';
  return (
    <p className="text-[13px] leading-tight">
      <span
        className={cn(
          unpaired ? STATUS_COLOR.unpaired : 'text-muted-foreground',
          unpaired && 'text-xs',
        )}
      >
        {tileStatusWords(tile, now)}
      </span>
      {unconfirmed > 0 && !unpaired && <UnconfirmedPill count={unconfirmed} plus={false} />}
    </p>
  );
}

// The status slot, labelled so a screen reader tells the states apart: the worst
// alert or warning, else asleep as a moon, else the healthy circle for an up
// System and an unknown ring for one never seen or unpaired.
function StatusSlot({ tile }: { tile: SystemTile }) {
  const { asleep, lane, level } = tile;
  if (level === undefined && asleep) {
    return (
      <span aria-label="Asleep" className="flex-none text-muted-foreground" role="img">
        <Moon aria-hidden="true" className="size-3" />
      </span>
    );
  }
  if (level !== undefined) {
    return (
      <span aria-label={level === 'alert' ? 'Alert' : 'Warning'} role="img">
        <ConditionGlyph kind={level} />
      </span>
    );
  }
  if (lane.status === 'never_seen' || lane.status === 'unpaired') {
    return (
      <span aria-label={lane.status === 'unpaired' ? 'Unpaired' : 'Never seen'} role="img">
        <ConditionGlyph kind="unknown" />
      </span>
    );
  }
  return (
    <span aria-label="Healthy" role="img">
      <ConditionGlyph kind="cleared" />
    </span>
  );
}

// The tile's top-right: the time left on a silence with a crossed-out bell, else
// the short time since Last seen, or "Never seen". Screen readers get the long form.
function TileCorner({ lane, now }: { lane: SystemGlance; now: number }) {
  const corner = 'flex-none text-xs whitespace-nowrap text-muted-foreground';
  if (lane.silencedUntil !== undefined) {
    const left = silenceLeft(now, lane.silencedUntil);
    return (
      <span
        aria-label={`Alerts silenced, ${left} left`}
        className={cn(corner, 'inline-flex items-center gap-1')}
        role="img"
      >
        <BellOff aria-hidden="true" className="size-3" />
        {left}
      </span>
    );
  }
  if (lane.lastSeenAt === undefined) {
    return <span className={corner}>Never seen</span>;
  }
  const age = formatSpanShort(now - lane.lastSeenAt);
  return (
    <span className={corner}>
      <span className="sr-only">{`Last seen ${age} ago`}</span>
      <span aria-hidden="true">{age}</span>
    </span>
  );
}

// The Systems as tiles, in the order given, two across on a phone and as many
// as fit from `sm`, seven at 1440 px: each links to its System and shows its
// health, its CPU since `from`, its Mem and Disk meters, its Services up, and
// how many of the `running` Sessions run on it.
export function FleetTiles({
  from,
  now,
  running = [],
  tiles,
}: {
  from: number;
  now: number;
  running?: readonly SessionKey[];
  tiles: readonly SystemTile<TileGlance>[];
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] sm:gap-3">
      {tiles.map((tile) => (
        <Link
          className={cn(
            'flex min-w-0 flex-col gap-1 rounded-xl border px-3 py-2.5 hover:border-muted-foreground',
            tile.level === 'alert' && 'border-status-critical/75',
            tile.level === 'warning' && 'border-status-serious/60',
            tile.asleep || tile.lane.status === 'unpaired' ? 'bg-muted/30' : 'card-surface',
          )}
          key={tile.lane.name}
          params={{ name: tile.lane.name }}
          to="/systems/$name"
        >
          <div className="flex items-center gap-1.5">
            <h3
              className={cn(
                'flex min-w-0 flex-1 items-center gap-1.5 text-[15px] font-semibold break-all',
                tile.asleep && 'text-muted-foreground',
              )}
            >
              <StatusSlot tile={tile} />
              {tile.lane.name}
            </h3>
            <TileCorner lane={tile.lane} now={now} />
          </div>
          <TileStatus now={now} tile={tile} />
          {tile.lane.lastSeenAt !== undefined && (
            <TileSparkline from={from} now={now} tile={tile} />
          )}
          <TileMeters now={now} tile={tile} />
          <TileFooter running={runningChip(running, tile.lane.name)} tile={tile} />
        </Link>
      ))}
    </div>
  );
}

// The tile's last line: its Services up, and how many Sessions run on it, in
// their Harness's color when they share one that has a color and in the
// neutral chip color otherwise. Neither shows when there is none.
function TileFooter({
  running,
  tile,
}: {
  running: ReturnType<typeof runningChip>;
  tile: SystemTile<TileGlance>;
}) {
  const { services } = tile.lane;
  if (services.total === 0 && running === undefined) {
    return null;
  }
  const color = running?.harness === undefined ? undefined : ownHarnessColor(running.harness);
  return (
    <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      {services.total > 0 && (
        <p className="text-xs text-muted-foreground tabular-nums">
          Services {services.up}/{services.total}
        </p>
      )}
      {running !== undefined && (
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs whitespace-nowrap tabular-nums',
            color === undefined && 'bg-secondary text-muted-foreground',
          )}
          data-harness={running.harness}
          style={
            color === undefined
              ? undefined
              : { background: `color-mix(in srgb, ${color} 16%, transparent)`, color }
          }
        >
          {running.count} running
        </span>
      )}
    </div>
  );
}
