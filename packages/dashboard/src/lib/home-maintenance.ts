// What Home's Maintenance card says: the packages pending on the Systems with
// an open Pending update, the Systems that need a reboot, and the Services
// with an update. All of it can wait; the card names none of it as a problem.

import { parseUpdateSubject } from '@heimdall/schema';

import type { Attention } from '../server/attention-types.ts';
import type { HeldPackages, HomeServiceUpdate, PendingPackages } from '../server/home-types.ts';
import { formatSpanShort } from './time.ts';

// An open Condition of `kind` on a paired System.
const isOpenOnPaired = (
  item: Attention,
  kind: 'pending_update' | 'reboot_required',
): item is Attention & { conditionId: string } => item.kind === kind && !item.unpaired;

// For each paired System with an open Pending update Condition, at any level,
// the packages the Hub holds as pending in the sources those Conditions name,
// as their Condition pages list them; its row links to the Condition whose
// source holds the most. A source that holds none is left out, and so is a
// System whose sources hold none, as Maintenance counts only a System with a
// package. The most packages first, then by name.
export const pendingPackages = (
  attention: readonly Attention[],
  held: readonly HeldPackages[],
): PendingPackages[] => {
  const bySystem = new Map<string, PendingPackages & { most: number }>();
  for (const item of attention) {
    if (!isOpenOnPaired(item, 'pending_update')) {
      continue;
    }
    const source = parseUpdateSubject(item.subject);
    const pending = held.find(
      ({ installation, manager, system }) =>
        system === item.system &&
        manager === source?.manager &&
        installation === source.installation,
    );
    if (pending === undefined || pending.packages === 0) {
      continue;
    }
    const before = bySystem.get(item.system);
    bySystem.set(item.system, {
      conditionId:
        before === undefined || pending.packages > before.most
          ? item.conditionId
          : before.conditionId,
      most: Math.max(before?.most ?? 0, pending.packages),
      packages: (before?.packages ?? 0) + pending.packages,
      security: (before?.security ?? 0) + pending.security,
      system: item.system,
    });
  }
  return [...bySystem.values()]
    .map(({ conditionId, packages, security, system }) => ({
      conditionId,
      packages,
      security,
      system,
    }))
    .toSorted((a, b) => b.packages - a.packages || a.system.localeCompare(b.system));
};

const counted = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

export type MaintenanceCard = {
  packages: { security: number; systems: PendingPackages[]; text: string } | undefined;
  reboots:
    | { oldest: string; systems: { conditionId: string; system: string }[]; text: string }
    | undefined;
  updates: { longest: string; security: number; text: string } | undefined;
};

// The packages row: "38 packages on 4 Systems" with the security updates
// among them, and each System with its count.
const packagesRow = (packages: readonly PendingPackages[]): MaintenanceCard['packages'] => {
  if (packages.length === 0) {
    return undefined;
  }
  const total = packages.reduce((sum, row) => sum + row.packages, 0);
  return {
    security: packages.reduce((sum, row) => sum + row.security, 0),
    systems: [...packages],
    text: `${counted(total, 'package', 'packages')} on ${counted(packages.length, 'System', 'Systems')}`,
  };
};

// The reboots row: "2 Systems need a reboot", how long the oldest has been
// open, and each System, the oldest first.
const rebootsRow = (attention: readonly Attention[], now: number): MaintenanceCard['reboots'] => {
  const open = attention
    .filter((item) => isOpenOnPaired(item, 'reboot_required'))
    .toSorted((a, b) => a.firstDetected - b.firstDetected || a.system.localeCompare(b.system));
  const [oldest] = open;
  if (oldest === undefined) {
    return undefined;
  }
  const age = formatSpanShort(Math.max(0, now - oldest.firstDetected));
  return {
    oldest: open.length === 1 ? `open ${age}` : `oldest ${age}`,
    systems: open.map(({ conditionId, system }) => ({ conditionId, system })),
    text:
      open.length === 1
        ? '1 System needs a reboot'
        : `${String(open.length)} Systems need a reboot`,
  };
};

// The updates row: "4 Services have an update", the security updates among
// them, and the Service whose update has waited longest with how long, or the
// first by name when no release dates any.
const updatesRow = (
  updates: readonly HomeServiceUpdate[],
  now: number,
): MaintenanceCard['updates'] => {
  const [longest] = updates.toSorted(
    (a, b) =>
      (a.since ?? Number.POSITIVE_INFINITY) - (b.since ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name) ||
      a.system.localeCompare(b.system),
  );
  if (longest === undefined) {
    return undefined;
  }
  return {
    longest:
      longest.since === undefined
        ? longest.name
        : `${longest.name} ${formatSpanShort(Math.max(0, now - longest.since))}`,
    security: updates.filter(({ security }) => security).length,
    text:
      updates.length === 1
        ? '1 Service has an update'
        : `${String(updates.length)} Services have an update`,
  };
};

// The card's three rows, each undefined when it has nothing to say.
export const maintenanceCard = (
  {
    attention,
    packages,
    updates,
  }: {
    attention: readonly Attention[];
    packages: readonly PendingPackages[];
    updates: readonly HomeServiceUpdate[];
  },
  now: number,
): MaintenanceCard => ({
  packages: packagesRow(packages),
  reboots: rebootsRow(attention, now),
  updates: updatesRow(updates, now),
});
