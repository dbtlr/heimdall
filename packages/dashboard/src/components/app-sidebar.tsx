import { Link, useRouterState } from '@tanstack/react-router';

import { laneSummary } from '../lib/attention.ts';
import { diskReading, meterLevels, tileOrder } from '../lib/fleet-tile.ts';
import type { SystemTile } from '../lib/fleet-tile.ts';
import { fleetAttention } from '../lib/fleet.ts';
import { systemSearch } from '../lib/system-search.ts';
import { emptyFleetText } from '../lib/unpaired.ts';
import { cn } from '../lib/utils.ts';
import { QUIET_AFTER_MS } from '../server/fleet-overview-types.ts';
import type { FleetGlance } from '../server/fleet-overview-types.ts';
import { DASHBOARD_VERSION } from '../version.ts';
import { activeNav, NAV_ITEMS, ServicesBadge } from './app-navigation.tsx';
import { AttentionStatus, namedItem, STATUS_COLOR, UnconfirmedPill } from './attention-status.tsx';
import { FILL_COLOR, StatusSlot, TileCorner } from './fleet-tiles.tsx';
import { FleetVerdict } from './fleet-verdict.tsx';

const SYSTEM_PATH = /^\/systems\/([^/]+)/u;

// The System the page is about, and on the System page itself the tab and range
// its rows keep, as the System pills do.
const useCurrentSystem = () =>
  useRouterState({
    select: (state) => {
      const match = SYSTEM_PATH.exec(state.location.pathname);
      const onSystemPage = state.matches.some((item) => item.routeId === '/systems/$name');
      return {
        keep: onSystemPage ? systemSearch(state.location.search) : undefined,
        name: match?.[1] === undefined ? undefined : decodeURIComponent(match[1]),
        path: state.location.pathname,
      };
    },
  });

// One thin bar filled to the percent, colored by the level of what is wrong
// with the resource. An unknown percent is an empty bar.
function MiniMeter({
  level,
  percent,
}: {
  level: 'alert' | 'note' | 'warning' | undefined;
  percent: number | undefined;
}) {
  return (
    <span className="h-[3px] rounded-full bg-border">
      <span
        className={cn(
          'block h-full rounded-full',
          level === undefined ? 'bg-[#6f8fc4]' : FILL_COLOR[level],
        )}
        style={{ width: `${String(Math.min(100, Math.max(0, percent ?? 0)))}%` }}
      />
    </span>
  );
}

// CPU, memory, and disk as three bars in one row; the tiles on the Fleet page
// carry the readable values.
function MiniMeters({ now, tile }: { now: number; tile: SystemTile }) {
  const { latest } = tile.lane;
  const levels = meterLevels(tile.items);
  const disk = latest === undefined ? undefined : diskReading(latest.disks, tile.items);
  const stale = latest !== undefined && now - latest.t > QUIET_AFTER_MS;
  return (
    <span aria-hidden="true" className={cn('grid grid-cols-3 gap-1.5', stale && 'opacity-50')}>
      <MiniMeter level={levels.cpu} percent={latest?.cpuBusyPercent} />
      <MiniMeter level={levels.memory} percent={latest?.memoryUsedPercent} />
      <MiniMeter level={levels.disk} percent={disk?.percent} />
    </span>
  );
}

// The worst open problem as small text, else the System's plain state.
function RowProblem({ tile }: { tile: SystemTile }) {
  const { items, lane } = tile;
  if (namedItem(items, lane.status) !== undefined) {
    return <AttentionStatus items={items} status={lane.status} />;
  }
  if (lane.status === 'unpaired') {
    return <span className={STATUS_COLOR.unpaired}>Unpaired</span>;
  }
  const { unconfirmed } = laneSummary(items);
  if (unconfirmed > 0) {
    return <UnconfirmedPill count={unconfirmed} plus={false} />;
  }
  if (lane.status === 'up') {
    return <span className={STATUS_COLOR.up}>Healthy</span>;
  }
  return lane.status === 'asleep' ? <span className={STATUS_COLOR.asleep}>Asleep</span> : null;
}

function SystemRow({
  current,
  keep,
  now,
  tile,
}: {
  current: boolean;
  keep: ReturnType<typeof systemSearch> | undefined;
  now: number;
  tile: SystemTile;
}) {
  const className = cn(
    'flex flex-col gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60',
    current && 'bg-accent',
    (tile.asleep || tile.lane.status === 'unpaired') && 'opacity-70',
  );
  const content = (
    <>
      <span className="flex items-center gap-1.5">
        <StatusSlot tile={tile} />
        <span className="min-w-0 flex-1 truncate font-medium">{tile.lane.name}</span>
        <TileCorner lane={tile.lane} now={now} />
      </span>
      <span className="text-xs">
        <RowProblem tile={tile} />
      </span>
      <MiniMeters now={now} tile={tile} />
    </>
  );
  const shared = {
    'aria-current': current ? ('page' as const) : undefined,
    className,
    params: { name: tile.lane.name },
    to: '/systems/$name' as const,
  };
  return keep === undefined ? (
    <Link {...shared}>{content}</Link>
  ) : (
    <Link {...shared} hash="" search={{ range: keep.range, tab: keep.tab }}>
      {content}
    </Link>
  );
}

// The wide-screen navigation: the brand with the fleet verdict, the app's
// destinations, and Fleet's Systems under Fleet, unpaired ones last. Without a
// glance (its read failed) it shows the destinations alone.
export function AppSidebar({ glance }: { glance: FleetGlance | undefined }) {
  const { keep, name, path } = useCurrentSystem();
  const active = activeNav(path);
  const now = glance?.now ?? 0;
  const paired = glance === undefined ? [] : tileOrder(glance.lanes, glance.attention, now);
  const unpaired =
    glance === undefined ? [] : tileOrder(glance.unpairedLanes, glance.attention, now);
  const { counts } = fleetAttention(glance?.attention ?? []);
  // As on the Fleet page, no verdict while no paired System has reported.
  const verdictShown = glance !== undefined && emptyFleetText(glance.lanes) === undefined;
  const onSystem = name !== undefined;
  return (
    <aside
      aria-label="Sidebar"
      className="flex h-full w-[248px] flex-col overflow-y-auto border-r bg-[#121826] pt-[env(safe-area-inset-top)]"
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-3">
        <span className="text-base font-bold tracking-[0.02em]">Heimdall</span>
        {verdictShown && <FleetVerdict counts={counts} />}
      </div>
      <nav aria-label="Main navigation" className="flex flex-1 flex-col gap-0.5 px-2 pb-3">
        {NAV_ITEMS.map(({ icon: Icon, label, to }) => {
          const selected = active === to;
          return (
            <div key={to}>
              <Link
                aria-current={selected && !(to === '/' && onSystem) ? 'page' : undefined}
                className={cn(
                  'flex min-h-9 items-center gap-2.5 rounded-md px-2 text-[15px] text-muted-foreground hover:bg-accent/60',
                  selected && 'font-semibold text-foreground',
                  selected && !(to === '/' && onSystem) && 'bg-accent',
                )}
                to={to}
              >
                <Icon aria-hidden="true" className="size-4" />
                <span className="inline-flex flex-1 items-center gap-1">
                  {label}
                  {to === '/services' && <ServicesBadge />}
                </span>
                {to === '/' && glance !== undefined && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {paired.length} {paired.length === 1 ? 'System' : 'Systems'}
                  </span>
                )}
              </Link>
              {to === '/' && paired.length + unpaired.length > 0 && (
                <div className="mt-0.5 mb-1 ml-4 flex flex-col gap-0.5 border-l pl-1.5">
                  {[...paired, ...unpaired].map((tile) => (
                    <SystemRow
                      current={tile.lane.name === name}
                      key={tile.lane.name}
                      keep={keep}
                      now={now}
                      tile={tile}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      <p className="px-4 pb-3 text-xs text-muted-foreground">v{DASHBOARD_VERSION}</p>
    </aside>
  );
}
