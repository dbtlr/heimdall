import { Link } from '@tanstack/react-router';

import { isSecurityUpdate } from '../lib/condition-detail.ts';
import {
  ago,
  checkSentence,
  isUpToDate,
  maintenanceSummary,
  nothingPending,
  pendingCheckNote,
  splitPackages,
  upstreamName,
} from '../lib/maintenance.ts';
import { cn } from '../lib/utils.ts';
import type {
  Maintenance,
  MaintenancePackage,
  MaintenanceServiceUpdate,
  MaintenanceSystem,
} from '../server/maintenance-types.ts';
import { MARK_COLOR } from './attention-status.tsx';

const CHIP = 'flex-none rounded-full bg-status-warning/15 px-2 py-0.5 text-xs whitespace-nowrap';

const HEADING = 'text-[11px] font-semibold tracking-[0.08em] text-dim uppercase';

// A package: its name, the versions it would move between, and for a security
// update a chip and how long the Hub has held it as one.
function PackageRow({ now, pkg }: { now: number; pkg: MaintenancePackage }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t py-1.5 first:border-t-0">
      <span className="min-w-0 break-all">{pkg.name}</span>
      <span className="min-w-0 text-xs text-muted-foreground tabular-nums">
        {`${pkg.installed ?? '?'} → ${pkg.available ?? '?'}`}
      </span>
      {isSecurityUpdate(pkg) && (
        <span className={cn(CHIP, MARK_COLOR.note, 'ml-auto')}>
          security
          {pkg.securitySince !== null && (
            <span className="ml-1 text-muted-foreground">{`since ${ago(pkg.securitySince, now)}`}</span>
          )}
        </span>
      )}
    </li>
  );
}

// A System's packages, security first: the first few, and the rest behind a
// "+N more" expander.
function Packages({ now, packages }: { now: number; packages: readonly MaintenancePackage[] }) {
  const { more, shown } = splitPackages(packages);
  const security = packages.filter(isSecurityUpdate).length;
  return (
    <div className="mt-3">
      <h3 className={HEADING}>
        {`Packages ${String(packages.length)}${security === 0 ? '' : ` · ${String(security)} security`}`}
      </h3>
      <ul className="mt-1 text-[13.5px]">
        {shown.map((pkg) => (
          <PackageRow key={`${pkg.manager}/${pkg.name}`} now={now} pkg={pkg} />
        ))}
      </ul>
      {more.length > 0 && (
        <details className="group">
          <summary className="min-h-9 cursor-pointer py-1.5 text-xs text-link hover:underline">
            {`+${String(more.length)} more`}
          </summary>
          <ul className="text-[13.5px]">
            {more.map((pkg) => (
              <PackageRow key={`${pkg.manager}/${pkg.name}`} now={now} pkg={pkg} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// A Service with a newer version: its versions, and when its upstream's
// releases found the update, and which upstream.
function ServiceUpdateRow({ now, update }: { now: number; update: MaintenanceServiceUpdate }) {
  const found = [
    update.since === undefined ? undefined : `found ${ago(update.since, now)} ago`,
    upstreamName(update.upstream),
  ].filter((part) => part !== undefined);
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 border-t py-1.5 first:border-t-0">
      <span className="min-w-0 break-all">{update.name}</span>
      <span className="min-w-0 text-xs text-muted-foreground tabular-nums">
        {`${update.installed ?? '?'} → ${update.available}`}
      </span>
      {found.length > 0 && (
        <span className="ml-auto text-xs text-muted-foreground">{found.join(' · ')}</span>
      )}
    </li>
  );
}

// One System's card: the System and its package managers with a pending
// reboot and how long it has been required, its packages, and its Services
// with an update. A System with none of them is a short card saying when it
// was last checked, or why its checks cannot show it is up to date; only an
// up to date one is quiet. A card that lists something under a check that is
// not current says why the list may be out of date. All of it can wait, so nothing here is tinted as a
// problem beyond the notes' own color.
function SystemCard({ now, system }: { now: number; system: MaintenanceSystem }) {
  const id = `maintenance-${system.system}`;
  const checkNote = nothingPending(system)
    ? checkSentence(system.check, now)
    : pendingCheckNote(system.check, now);
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'min-w-0 card-surface rounded-xl border px-4 py-3.5',
        isUpToDate(system) && 'opacity-80',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="min-w-0 text-[15px] font-semibold" id={id}>
          <Link
            className="rounded-md bg-secondary px-2 py-0.5 hover:underline"
            params={{ name: system.system }}
            to="/systems/$name"
          >
            {system.system}
          </Link>
        </h2>
        <span className="text-xs text-muted-foreground">{system.managers.join(' · ')}</span>
        {system.rebootSince !== undefined && (
          <span className={cn(CHIP, MARK_COLOR.note, 'ml-auto border border-current/40')}>
            {`Reboot pending · ${ago(system.rebootSince, now)}`}
          </span>
        )}
      </div>
      {checkNote !== undefined && (
        <p className="mt-3 text-[13.5px] break-words text-muted-foreground">{checkNote}</p>
      )}
      {system.packages.length > 0 && <Packages now={now} packages={system.packages} />}
      {system.updates.length > 0 && (
        <div className="mt-3">
          <h3 className={HEADING}>Service updates</h3>
          <ul className="mt-1 text-[13.5px]">
            {system.updates.map((update) => (
              <ServiceUpdateRow key={update.name} now={now} update={update} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// The Maintenance page's body: a sentence counting what can wait, then a card
// per System in the order given, two across on a wide screen and stacked on a
// phone.
export function MaintenanceCards({ maintenance }: { maintenance: Maintenance }) {
  const { now, systems } = maintenance;
  return (
    <>
      <p className="pb-4 text-sm text-muted-foreground">{maintenanceSummary(systems)}</p>
      <div className="grid items-start gap-3 lg:grid-cols-2">
        {systems.map((system) => (
          <SystemCard key={system.system} now={now} system={system} />
        ))}
      </div>
    </>
  );
}
