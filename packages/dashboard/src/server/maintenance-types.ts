// What the Maintenance page reads: for each paired System, the packages pending
// in its package sources, what its package checks show, a pending reboot, and
// its Services with an update. Times are epoch milliseconds.

import type { PendingPackage } from './condition-detail-types.ts';

// A package the Hub holds as pending, with its package manager's display name.
// `name` is the full identity the manager reports; `label` is the short name
// people know it by, and `cask` marks a Homebrew cask.
export type MaintenancePackage = PendingPackage & {
  cask: boolean;
  label: string;
  manager: string;
};

// Whether a System's package checks can show that nothing is pending. Only a
// check that ran within a day, succeeded, and read package metadata no older
// than seven days can, so `current` means every package source has one, `at`
// the oldest of them. Otherwise the first source, by manager, without one
// says why: its latest check could not run (`failed`), ran too long ago
// (`old`, `at` when it ran), or read metadata too old or of unknown age
// (`metadata`, `at` the metadata's time when known), or stored in a form the
// dashboard cannot read (`unreadable`). `none` is a System no package source
// has reported for.
export type MaintenanceCheck =
  | { at: number; kind: 'current' }
  | { kind: 'none' }
  | { kind: 'failed'; manager: string; reason: string }
  | { at: number; kind: 'old'; manager: string }
  | { at: number | null; kind: 'metadata'; manager: string }
  | { kind: 'unreadable'; manager: string };

// A Service with a newer version available: `since` is when its upstream's
// releases first found it, undefined for an update a package manager reports.
export type MaintenanceServiceUpdate = {
  available: string;
  installed: string | null;
  name: string;
  since: number | undefined;
  upstream: string | null;
};

export type MaintenanceSystem = {
  check: MaintenanceCheck;
  // The package managers it has reported, by name, sorted.
  managers: string[];
  packages: MaintenancePackage[];
  // When a reboot was first required, undefined when none is pending.
  rebootSince: number | undefined;
  system: string;
  updates: MaintenanceServiceUpdate[];
};

export type Maintenance = { now: number; systems: MaintenanceSystem[] };
