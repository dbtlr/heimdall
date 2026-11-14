// What the Maintenance page says: its Systems in order, the packages it shows
// of each, what a card says of its package checks, and the summary above them.
// All of it can wait; nothing here is tinted as a problem.

import type {
  MaintenanceCheck,
  MaintenancePackage,
  MaintenanceSystem,
} from '../server/maintenance-types.ts';
import { isSecurityUpdate } from './condition-detail.ts';
import { formatSpanShort } from './time.ts';

// The packages a System's card shows before its "more" expander.
export const PACKAGES_SHOWN = 5;

const securityCount = (system: MaintenanceSystem) =>
  system.packages.filter(isSecurityUpdate).length;

// Whether a System has nothing pending that the Hub holds: no package, no
// reboot, and no Service update. Its card is the short one.
export const nothingPending = (system: MaintenanceSystem): boolean =>
  system.packages.length === 0 && system.rebootSince === undefined && system.updates.length === 0;

// Whether a System is up to date: nothing pending, and every package source
// checked recently enough to show it. A failed, old, or missing check is not
// proof that nothing is pending.
export const isUpToDate = (system: MaintenanceSystem): boolean =>
  nothingPending(system) && system.check.kind === 'current';

// Security updates first, then by the name shown, then by full identity.
const securityFirst = (a: MaintenancePackage, b: MaintenancePackage) =>
  Number(isSecurityUpdate(b)) - Number(isSecurityUpdate(a)) ||
  a.label.localeCompare(b.label) ||
  a.name.localeCompare(b.name);

// The Systems with the most security updates first, then the most packages,
// then a pending reboot, then the most Service updates, then by name; an up
// to date System falls after every other.
export const orderMaintenance = (systems: readonly MaintenanceSystem[]): MaintenanceSystem[] =>
  systems.toSorted(
    (a, b) =>
      Number(isUpToDate(a)) - Number(isUpToDate(b)) ||
      securityCount(b) - securityCount(a) ||
      b.packages.length - a.packages.length ||
      Number(b.rebootSince !== undefined) - Number(a.rebootSince !== undefined) ||
      b.updates.length - a.updates.length ||
      a.system.localeCompare(b.system),
  );

// The packages a card lists, security first, and those behind "more": the
// first few, and never fewer than every security update.
export const splitPackages = (
  packages: readonly MaintenancePackage[],
): { more: MaintenancePackage[]; shown: MaintenancePackage[] } => {
  const ordered = packages.toSorted(securityFirst);
  const cut = Math.max(PACKAGES_SHOWN, ordered.filter(isSecurityUpdate).length);
  return { more: ordered.slice(cut), shown: ordered.slice(0, cut) };
};

// How long before `now`, in its largest unit: "4 d".
export const ago = (at: number, now: number): string => formatSpanShort(Math.max(0, now - at));

// Why a System's checks cannot show what is pending on it.
const whyUnknown = (check: Exclude<MaintenanceCheck, { kind: 'current' }>, now: number): string => {
  if (check.kind === 'none') {
    return 'no package check has reported';
  }
  if (check.kind === 'failed') {
    return `the ${check.manager} check failed (${check.reason.replace(/\.$/u, '')})`;
  }
  if (check.kind === 'unreadable') {
    return `the ${check.manager} check was stored in a form this page cannot read`;
  }
  if (check.kind === 'old') {
    return `${check.manager} was last checked ${ago(check.at, now)} ago`;
  }
  return check.at === null
    ? `${check.manager}'s package metadata is of unknown age`
    : `${check.manager}'s package metadata is ${ago(check.at, now)} old`;
};

// What the card of a System with nothing pending says: up to date and when
// it was checked, or, when its checks cannot show that, why not.
export const checkSentence = (check: MaintenanceCheck, now: number): string =>
  check.kind === 'current'
    ? `Up to date. Checked ${ago(check.at, now)} ago.`
    : `Not known to be up to date: ${whyUnknown(check, now)}.`;

// What the card of a System with something pending says of its checks:
// nothing when they are current, else that what it lists may be out of date,
// and why.
export const pendingCheckNote = (check: MaintenanceCheck, now: number): string | undefined =>
  check.kind === 'current'
    ? undefined
    : `What is listed may be out of date: ${whyUnknown(check, now)}.`;

const counted = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

// The sentence under the heading: how many package updates on how many
// Systems and how many of them security updates, the reboots pending, the
// Services with an update, and the Systems whose checks cannot show what is
// pending; each part left out when it is zero.
export const maintenanceSummary = (systems: readonly MaintenanceSystem[]): string => {
  if (systems.length === 0) {
    return 'No paired System.';
  }
  const packages = systems.reduce((sum, { packages: held }) => sum + held.length, 0);
  const security = systems.reduce((sum, system) => sum + securityCount(system), 0);
  const reboots = systems.filter(({ rebootSince }) => rebootSince !== undefined).length;
  const updates = systems.reduce((sum, { updates: held }) => sum + held.length, 0);
  const withPackages = systems.filter(({ packages: held }) => held.length > 0).length;
  const unchecked = systems.filter(({ check }) => check.kind !== 'current').length;
  const pending = [
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
  if (unchecked === 0) {
    return pending.length === 0 ? 'Every System is up to date.' : pending.join(' ');
  }
  return [
    ...(pending.length === 0 ? ['No update is known to be pending.'] : pending),
    `${counted(unchecked, 'System has', 'Systems have')} no current package check.`,
  ].join(' ');
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
