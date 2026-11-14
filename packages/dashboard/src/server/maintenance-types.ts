// What the Maintenance page reads: for each paired System, the packages pending
// in its package sources, a pending reboot, and its Services with an update.
// Times are epoch milliseconds.

// A package the Hub holds as pending. `security` is true when the latest
// check calls it one or the Hub has held it as one since an earlier check.
export type MaintenancePackage = {
  available: string | null;
  installed: string | null;
  manager: string;
  name: string;
  security: boolean;
  securitySince: number | null;
};

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
  // The newest check of any of its package sources, undefined before the first.
  checkedAt: number | undefined;
  // The package managers it has reported, by name, sorted.
  managers: string[];
  packages: MaintenancePackage[];
  // When a reboot was first required, undefined when none is pending.
  rebootSince: number | undefined;
  system: string;
  updates: MaintenanceServiceUpdate[];
};

export type Maintenance = { now: number; systems: MaintenanceSystem[] };
