// What the Maintenance page says: its Systems in order, the packages it shows
// of each, and the summary above them. All of it can wait; nothing here is
// tinted as a problem.

import type { MaintenancePackage, MaintenanceSystem } from '../server/maintenance-types.ts';

// The packages a System's card shows before its "more" expander.
export const PACKAGES_SHOWN = 5;

const securityCount = (system: MaintenanceSystem) =>
  system.packages.filter(({ security }) => security).length;

// Security updates first, then by name.
const securityFirst = (a: MaintenancePackage, b: MaintenancePackage) =>
  Number(b.security) - Number(a.security) || a.name.localeCompare(b.name);

// Each System with its packages security first, the Systems with the most
// security updates first, then the most packages, then a pending reboot, then
// by name; a System with nothing to do falls last among them.
export const orderMaintenance = (systems: readonly MaintenanceSystem[]): MaintenanceSystem[] =>
  systems
    .map((system) => ({ ...system, packages: system.packages.toSorted(securityFirst) }))
    .toSorted(
      (a, b) =>
        securityCount(b) - securityCount(a) ||
        b.packages.length - a.packages.length ||
        Number(b.rebootSince !== undefined) - Number(a.rebootSince !== undefined) ||
        a.system.localeCompare(b.system),
    );

// The packages a card lists, security first, and those behind "more": the
// first few, and never fewer than every security update.
export const splitPackages = (
  packages: readonly MaintenancePackage[],
): { more: MaintenancePackage[]; shown: MaintenancePackage[] } => {
  const ordered = packages.toSorted(securityFirst);
  const cut = Math.max(PACKAGES_SHOWN, ordered.filter(({ security }) => security).length);
  return { more: ordered.slice(cut), shown: ordered.slice(0, cut) };
};

const counted = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

// The sentence under the heading: how many package updates on how many
// Systems and how many of them security updates, the reboots pending, and
// the Services with an update; each part left out when it is zero.
export const maintenanceSummary = (systems: readonly MaintenanceSystem[]): string => {
  if (systems.length === 0) {
    return 'No paired System.';
  }
  const packages = systems.reduce((sum, { packages: held }) => sum + held.length, 0);
  const security = systems.reduce((sum, system) => sum + securityCount(system), 0);
  const reboots = systems.filter(({ rebootSince }) => rebootSince !== undefined).length;
  const updates = systems.reduce((sum, { updates: held }) => sum + held.length, 0);
  const withPackages = systems.filter(({ packages: held }) => held.length > 0).length;
  const parts = [
    packages === 0
      ? undefined
      : `${counted(packages, 'package update', 'package updates')} on ${counted(withPackages, 'System', 'Systems')}${
          security === 0 ? '' : `, ${String(security)} of them security`
        }.`,
    reboots === 0 ? undefined : `${counted(reboots, 'reboot', 'reboots')} pending.`,
    updates === 0
      ? undefined
      : `${counted(updates, 'Service update', 'Service updates')} available.`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? 'Every System is up to date.' : parts.join(' ');
};

const UPSTREAM_NAMES: Record<string, string> = {
  apt: 'APT',
  brew: 'Homebrew',
  github: 'GitHub',
  npm: 'npm',
  oci: 'OCI',
};

// The upstream a Service's updates come from, by its source: "GitHub" for
// `github:owner/repo`. Undefined for none or one of another source.
export const upstreamName = (upstream: string | null): string | undefined =>
  upstream === null ? undefined : UPSTREAM_NAMES[upstream.split(':')[0] ?? ''];
