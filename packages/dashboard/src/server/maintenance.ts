// What the Maintenance page reads. Three statements over every paired System,
// so their count does not grow with Systems, packages, or Services; each
// reads the Hub's current state, not history, so none grows with the archive.

import { PendingUpdateSchema, UPDATE_MANAGER_NAMES } from '@heimdall/schema';
import type { SQL } from 'bun';

import { orderMaintenance } from '../lib/maintenance.ts';
import { bySystem } from './hub-rows.ts';
import type { Maintenance, MaintenancePackage, MaintenanceSystem } from './maintenance-types.ts';
import { readServiceGlance } from './services.ts';

type SystemRow = {
  checked_at: Date | null;
  first_required_at: Date | null;
  managers: string[] | null;
  system: string;
};

type PackageRow = {
  manager: string;
  name: string;
  pending_update: unknown;
  security_since: Date | null;
  system: string;
};

const managerName = (manager: string): string =>
  Object.entries(UPDATE_MANAGER_NAMES).find(([key]) => key === manager)?.[1] ?? manager;

// Every paired System: the package managers it has reported with the newest
// of their checks, and when a reboot was first required, if one is.
const readSystems = (sql: SQL): Promise<SystemRow[]> => sql`
  SELECT p.system, m.managers, m.checked_at, r.first_required_at
  FROM paired_systems p
  LEFT JOIN (
    SELECT system, array_agg(DISTINCT manager) AS managers, max(observed_at) AS checked_at
    FROM update_managers
    WHERE NOT withdrawn
    GROUP BY system
  ) m ON m.system = p.system
  LEFT JOIN reboot_observations r
    ON r.system = p.system AND NOT r.withdrawn AND r.first_required_at IS NOT NULL
`;

// The packages the Hub holds as pending on each paired System, which a failed
// or stale check leaves in place.
const readPackages = (sql: SQL): Promise<PackageRow[]> => sql`
  SELECT u.system, u.manager, u.name, u.pending_update, u.security_since
  FROM update_subjects u
  JOIN paired_systems p ON p.system = u.system
`;

const toPackage = (row: PackageRow): MaintenancePackage => {
  const { available, installed, security } = PendingUpdateSchema.parse(row.pending_update);
  return {
    available,
    installed,
    manager: managerName(row.manager),
    name: row.name,
    // The same rule as the Condition page: a package the latest check calls a
    // security update, or one the Hub has held as one since an earlier check.
    security: row.security_since !== null || security === true,
    securitySince: row.security_since?.getTime() ?? null,
  };
};

// Each paired System with the packages the Hub holds as pending on it,
// security first, a pending reboot, and the Services with an update, ordered
// for the page.
export const readMaintenance = async (sql: SQL, now: number): Promise<Maintenance> => {
  const [systems, packages, services] = await Promise.all([
    readSystems(sql),
    readPackages(sql),
    readServiceGlance(sql, now),
  ]);
  const packagesOf = bySystem(packages);
  const updatesOf = bySystem(services.updates);
  return {
    now,
    systems: orderMaintenance(
      systems.map((row): MaintenanceSystem => {
        const held = (packagesOf.get(row.system) ?? []).map(toPackage);
        return {
          checkedAt: row.checked_at?.getTime(),
          managers: [
            ...new Set(
              [...(row.managers ?? []), ...held.map(({ manager }) => manager)].map(managerName),
            ),
          ].toSorted(),
          packages: held,
          rebootSince: row.first_required_at?.getTime(),
          system: row.system,
          updates: (updatesOf.get(row.system) ?? []).map(
            ({ installed, name, since, upstream, version }) => ({
              available: version,
              installed,
              name,
              since,
              upstream,
            }),
          ),
        };
      }),
    ),
  };
};
