// What the Maintenance page reads. Four statements over every paired System,
// so their count does not grow with Systems, packages, or Services; each
// reads the Hub's current state, not history, so none grows with the archive.

import {
  freshUpdateTime,
  PendingUpdateSchema,
  UPDATE_METADATA_MAX_AGE_MS,
  UpdateManagerSchema,
  updateManagerName,
} from '@heimdall/schema';
import type { UpdateManager } from '@heimdall/schema';
import type { SQL } from 'bun';

import { orderMaintenance } from '../lib/maintenance.ts';
import { inSnapshot } from './fleet-overview.ts';
import { bySystem } from './hub-rows.ts';
import type {
  Maintenance,
  MaintenanceCheck,
  MaintenancePackage,
  MaintenanceSystem,
} from './maintenance-types.ts';
import { readServiceGlance } from './services.ts';

type SystemRow = { first_required_at: Date | null; system: string };

type SourceRow = { observation: unknown; system: string };

type PackageRow = {
  manager: string;
  name: string;
  pending_update: unknown;
  security_since: Date | null;
  system: string;
};

// Every paired System, and when a reboot was first required, if one is.
const readSystems = (sql: SQL): Promise<SystemRow[]> => sql`
  SELECT p.system, r.first_required_at
  FROM paired_systems p
  LEFT JOIN reboot_observations r
    ON r.system = p.system AND NOT r.withdrawn AND r.first_required_at IS NOT NULL
`;

// The latest check of each package source on each paired System.
const readSources = (sql: SQL): Promise<SourceRow[]> => sql`
  SELECT u.system, u.observation
  FROM update_managers u
  JOIN paired_systems p ON p.system = u.system
  WHERE NOT u.withdrawn
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
    manager: updateManagerName(row.manager),
    name: row.name,
    security,
    securitySince: row.security_since?.getTime() ?? null,
  };
};

// What one source's latest check shows at `now`, by the rule the Hub clears a
// pending package by: a check within a day that succeeded on metadata no
// older than seven days.
const sourceCheck = (source: UpdateManager, now: number): MaintenanceCheck => {
  const manager = updateManagerName(source.manager);
  if (!freshUpdateTime(source.observedAt, now)) {
    return { at: source.observedAt, kind: 'old', manager };
  }
  if (source.result.kind === 'unavailable') {
    return { kind: 'failed', manager, reason: source.result.reason };
  }
  const { metadataAt } = source.result;
  if (metadataAt === null || !freshUpdateTime(metadataAt, now, UPDATE_METADATA_MAX_AGE_MS)) {
    return { at: metadataAt, kind: 'metadata', manager };
  }
  return { at: source.observedAt, kind: 'current' };
};

// What a System's sources show together: current only when each is, at the
// oldest of their checks; else the first, by manager, that is not.
const systemCheck = (sources: readonly UpdateManager[], now: number): MaintenanceCheck => {
  const checks = sources
    .toSorted(
      (a, b) => a.manager.localeCompare(b.manager) || a.installation.localeCompare(b.installation),
    )
    .map((source) => sourceCheck(source, now));
  if (checks.length === 0) {
    return { kind: 'none' };
  }
  const failing = checks.find(({ kind }) => kind !== 'current');
  if (failing !== undefined) {
    return failing;
  }
  return { at: Math.min(...sources.map(({ observedAt }) => observedAt)), kind: 'current' };
};

// Each paired System with what its package checks show, the packages the Hub
// holds as pending on it, a pending reboot, and the Services with an update,
// ordered for the page.
const readMaintenanceSnapshot = async (sql: SQL, now: number): Promise<Maintenance> => {
  const [systems, sources, packages, services] = await Promise.all([
    readSystems(sql),
    readSources(sql),
    readPackages(sql),
    readServiceGlance(sql, now),
  ]);
  const sourcesOf = bySystem(sources);
  const packagesOf = bySystem(packages);
  const updatesOf = bySystem(services.updates);
  return {
    now,
    systems: orderMaintenance(
      systems.map((row): MaintenanceSystem => {
        const checked = (sourcesOf.get(row.system) ?? []).map(({ observation }) =>
          UpdateManagerSchema.parse(observation),
        );
        const held = (packagesOf.get(row.system) ?? []).map(toPackage);
        return {
          check: systemCheck(checked, now),
          managers: [
            ...new Set([
              ...checked.map(({ manager }) => updateManagerName(manager)),
              ...held.map(({ manager }) => manager),
            ]),
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

// One snapshot, so a Report stored between the reads cannot pair a fresh
// package check with the packages it made pending before it.
export const readMaintenance = inSnapshot(readMaintenanceSnapshot);
