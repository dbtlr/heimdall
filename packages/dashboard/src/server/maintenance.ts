// What the Maintenance page reads. Four statements over every paired System,
// so their count does not grow with Systems, packages, or Services; each
// reads the Hub's current state, not history, so none grows with the archive.

import {
  freshUpdateTime,
  UPDATE_METADATA_MAX_AGE_MS,
  UpdateManagerSchema,
  updateManagerName,
} from '@heimdall/schema';
import type { UpdateManager } from '@heimdall/schema';
import type { SQL } from 'bun';

import { orderMaintenance } from '../lib/maintenance.ts';
import { ownArchitecture, packageLabel } from '../lib/package-names.ts';
import { inSnapshot } from './fleet-overview.ts';
import { bySystem } from './hub-rows.ts';
import type {
  Maintenance,
  MaintenanceCheck,
  MaintenancePackage,
  MaintenanceSystem,
} from './maintenance-types.ts';
import { readServiceGlance } from './services.ts';
import { pendingPackageOf } from './update-observations.ts';

type SystemRow = { first_required_at: Date | null; system: string };

type SourceRow = { installation: string; manager: string; observation: unknown; system: string };

// A source's row with its observation, undefined when the stored observation
// no longer parses.
type Source = { observation: UpdateManager | undefined; row: SourceRow };

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
  SELECT u.system, u.manager, u.installation, u.observation
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

const toPackage = (row: PackageRow, own: string | undefined): MaintenancePackage => ({
  ...pendingPackageOf(row),
  ...packageLabel(row.name, row.manager, own),
  manager: updateManagerName(row.manager),
});

const sourceOf = (row: SourceRow): Source => {
  const parsed = UpdateManagerSchema.safeParse(row.observation);
  return { observation: parsed.success ? parsed.data : undefined, row };
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
// oldest of their checks; else the first, by manager, that is not. A source
// whose stored observation no longer parses has no current check, and says so.
const systemCheck = (sources: readonly Source[], now: number): MaintenanceCheck => {
  const checks = sources
    .toSorted(
      (a, b) =>
        a.row.manager.localeCompare(b.row.manager) ||
        a.row.installation.localeCompare(b.row.installation),
    )
    .map(({ observation, row }): MaintenanceCheck =>
      observation === undefined
        ? { kind: 'unreadable', manager: updateManagerName(row.manager) }
        : sourceCheck(observation, now),
    );
  if (checks.length === 0) {
    return { kind: 'none' };
  }
  const failing = checks.find(({ kind }) => kind !== 'current');
  if (failing !== undefined) {
    return failing;
  }
  return {
    at: Math.min(...sources.map(({ observation }) => observation?.observedAt ?? now)),
    kind: 'current',
  };
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
        const checked = (sourcesOf.get(row.system) ?? []).map(sourceOf);
        const heldRows = packagesOf.get(row.system) ?? [];
        // The installed census decides when there is one; pending names are
        // the fallback, since a System can have more foreign updates pending
        // than native ones.
        const census = checked.flatMap(({ observation }) =>
          observation?.manager === 'apt' ? (observation.installed?.names ?? []) : [],
        );
        const own = ownArchitecture(
          census.length > 0
            ? census
            : heldRows.filter(({ manager }) => manager === 'apt').map(({ name }) => name),
        );
        const held = heldRows.map((pkg) => toPackage(pkg, own));
        return {
          check: systemCheck(checked, now),
          managers: [
            ...new Set([
              ...checked.map(({ row: source }) => updateManagerName(source.manager)),
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
