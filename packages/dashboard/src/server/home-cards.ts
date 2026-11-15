// What Home's Maintenance, What changed, and Jobs cards read. Each read is one
// statement over every paired System, so the count of statements does not
// grow with Systems, Services, jobs, or changes.

import { nextScheduledTime } from '@heimdall/schema';
import type { SQL } from 'bun';

import { isSecurityUpdate } from '../lib/condition-detail.ts';
import { homeJob, orderJobs } from '../lib/home-jobs.ts';
import { withoutServicePackages } from '../lib/maintenance.ts';
import type { Attention } from './attention-types.ts';
import type {
  AvailableUpdate,
  Change,
  HeldPackages,
  HomeJob,
  HomeServiceUpdate,
  ServiceChange,
} from './home-types.ts';
import { bySystem, conditionKind, scheduleOf, toRun } from './hub-rows.ts';
import type { RunRow } from './hub-rows.ts';
import { readServiceStops } from './service-stops.ts';
import { pendingPackageOf } from './update-observations.ts';

type HeldRow = {
  installation: string;
  manager: string;
  name: string;
  pending_update: unknown;
  security_since: Date | null;
  system: string;
};

// The packages the Hub holds as pending in each package source of each paired
// System, which a failed or stale check leaves in place, and the security
// updates among them: a package the latest check calls one, or one the Hub has
// held as one since an earlier check. By the rule Maintenance lists packages
// by, the package a Service is updated from is left out of `held`, and the
// Service's update in `updates` is a security update when that package is one.
export const readHeldPackages = async (
  sql: SQL,
  available: readonly AvailableUpdate[],
): Promise<{ held: HeldPackages[]; updates: HomeServiceUpdate[] }> => {
  const rows: HeldRow[] = await sql`
    SELECT u.system, u.manager, u.installation, u.name, u.pending_update, u.security_since
    FROM update_subjects u
    JOIN paired_systems p ON p.system = u.system
  `;
  const held = new Map<string, HeldPackages>();
  const secure = new Set<string>();
  for (const [system, systemRows] of bySystem(rows)) {
    const { packages, updates } = withoutServicePackages({
      packages: systemRows.map((row) =>
        Object.assign(pendingPackageOf(row), {
          installation: row.installation,
          manager: row.manager,
        }),
      ),
      updates: available
        .filter((update) => update.system === system)
        .map(({ name, upstream }) => ({ name, security: false, upstream })),
    });
    for (const { name } of updates.filter(({ security }) => security)) {
      secure.add(JSON.stringify([system, name]));
    }
    for (const pkg of packages) {
      const key = JSON.stringify([system, pkg.manager, pkg.installation]);
      const before = held.get(key);
      held.set(key, {
        installation: pkg.installation,
        manager: pkg.manager,
        packages: (before?.packages ?? 0) + 1,
        security: (before?.security ?? 0) + Number(isSecurityUpdate(pkg)),
        system,
      });
    }
  }
  return {
    held: [...held.values()],
    updates: available.map((update) => ({
      ...update,
      security: secure.has(JSON.stringify([update.system, update.name])),
    })),
  };
};

type JobRow = {
  latest_run: RunRow['latest_run'] | null;
  name: string;
  schedule: unknown;
  system: string;
  time_zone: string | null;
};

// Every job a paired System's provisioner recorded, with its latest run and
// the Job failing and Job overdue Conditions open on it in `attention`; a job
// that never ran is due at its next scheduled time in its System's zone. In
// the order Home lists them.
export const readHomeJobs = async (
  sql: SQL,
  { attention, now }: { attention: readonly Attention[]; now: number },
): Promise<HomeJob[]> => {
  const rows: JobRow[] = await sql`
    SELECT r.system, r.name, r.record->'schedule' AS schedule, u.latest_run, s.time_zone
    FROM mirrored_records r
    JOIN paired_systems p ON p.system = r.system
    LEFT JOIN mirrored_runs u ON u.system = r.system AND u.job = r.name
    LEFT JOIN systems s ON s.name = r.system
    WHERE r.kind = 'job'
  `;
  const open = (row: JobRow, kind: 'job_failing' | 'job_overdue') =>
    attention.find(
      (item) => item.kind === kind && item.system === row.system && item.subject === row.name,
    );
  return orderJobs(
    rows.map((row) =>
      homeJob({
        dueAt:
          row.latest_run !== null || row.time_zone === null
            ? undefined
            : nextScheduledTime({
                after: now,
                schedule: scheduleOf(row.schedule),
                timeZone: row.time_zone,
              }),
        failing: open(row, 'job_failing') !== undefined,
        latestRun: row.latest_run === null ? undefined : toRun(row.latest_run),
        name: row.name,
        overdueSince: open(row, 'job_overdue')?.firstDetected,
        system: row.system,
      }),
    ),
  );
};

// Each Service change between `since` and `now`: every installed version that
// replaced another, and every Service stop. A version first seen, or one now
// unknown, is no change, and one read as unknown in between is passed over, so
// the change is from the last version known. With `system`, only that System's,
// paired or not, since an unpaired System keeps its history; without it, every
// paired System's, and every unpaired System's too with `includeUnpaired`.
export const readServiceChanges = async (
  sql: SQL,
  {
    includeUnpaired = false,
    now,
    since,
    system: only,
  }: { includeUnpaired?: boolean; now: number; since: number; system?: string },
): Promise<ServiceChange[]> => {
  const from = new Date(since);
  const to = new Date(now);
  const filter = only ?? null;
  const [versions, stops]: [
    {
      first_seen_at: Date;
      previous: string | null;
      service: string;
      system: string;
      version: string | null;
    }[],
    Awaited<ReturnType<typeof readServiceStops>>,
  ] = await Promise.all([
    sql`
      SELECT v.system, v.service, v.version, v.first_seen_at, previous.version AS previous
      FROM service_versions v
      LEFT JOIN paired_systems p ON p.system = v.system
      JOIN LATERAL (
        SELECT version FROM service_versions w
        WHERE w.system = v.system AND w.service = v.service AND w.first_seen_at < v.first_seen_at
          AND w.version IS NOT NULL
        ORDER BY w.first_seen_at DESC LIMIT 1
      ) previous ON true
      WHERE v.first_seen_at >= ${from} AND v.first_seen_at <= ${to}
        AND (${filter}::text IS NULL OR v.system = ${filter})
        AND (${filter}::text IS NOT NULL OR ${includeUnpaired} OR p.system IS NOT NULL)
    `,
    readServiceStops(sql, {
      includeUnpaired: only !== undefined || includeUnpaired,
      since: from,
      ...(only === undefined ? {} : { system: only }),
    }),
  ]);
  return [
    ...versions.flatMap(({ first_seen_at, previous, service, system, version }): ServiceChange[] =>
      previous === null || version === null || previous === version
        ? []
        : [
            {
              at: first_seen_at.getTime(),
              from: previous,
              kind: 'version',
              service,
              system,
              to: version,
            },
          ],
    ),
    ...stops.flatMap(
      ({ ongoing, restarts, service, startedAt, stoppedAt, system }): ServiceChange[] => {
        const at = Date.parse(stoppedAt);
        const lasted = startedAt === null ? undefined : Math.max(0, Date.parse(startedAt) - at);
        return at > now ? [] : [{ at, kind: 'stop', lasted, ongoing, restarts, service, system }];
      },
    ),
  ];
};

// Each change on a paired System between `since` and `now`: its Service
// changes, and every Condition raised or cleared at warning or alert.
export const readChanges = async (
  sql: SQL,
  { now, since }: { now: number; since: number },
): Promise<Change[]> => {
  const from = new Date(since);
  const to = new Date(now);
  const [services, transitions]: [
    ServiceChange[],
    {
      action: 'cleared' | 'raised';
      at: Date;
      id: string;
      kind: string;
      subject: string;
      system: string;
    }[],
  ] = await Promise.all([
    readServiceChanges(sql, { now, since }),
    sql`
      SELECT c.id::text AS id, c.system, c.kind, c.subject, t.action, t.at
      FROM conditions c
      JOIN paired_systems p ON p.system = c.system
      JOIN condition_transitions t ON t.condition = c.id
      WHERE (c.raised_at >= ${from} OR c.cleared_at >= ${from})
        AND t.action IN ('raised', 'cleared') AND t.level IN ('warning', 'alert')
        AND t.at >= ${from} AND t.at <= ${to}
    `,
  ]);
  return [
    ...services,
    ...transitions.map(({ action, at, id, kind, subject, system }): Change => ({
      action,
      at: at.getTime(),
      condition: conditionKind(kind),
      conditionId: id,
      kind: 'condition',
      subject,
      system,
    })),
  ];
};
