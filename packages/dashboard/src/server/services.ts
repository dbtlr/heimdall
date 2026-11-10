import type { SQL } from 'bun';

import { isAsleep } from '../lib/fleet.ts';
import { serviceUpdate, upstreamSince } from '../lib/service-updates.ts';
import type { UpstreamRelease } from '../lib/service-updates.ts';
import { countsAsUp, serviceStatus, sortServices } from '../lib/services.ts';
import type { ServiceSummary } from '../lib/services.ts';
import { OLD_EVIDENCE_MS } from './attention-types.ts';
import { QUIET_AFTER_MS } from './fleet-overview-types.ts';
import type { AvailableUpdate } from './home-types.ts';
import type { ChecksRow } from './hub-rows.ts';
import { parseUpdateObservations, upstreamCheckOf } from './update-observations.ts';
import type { UpstreamCheckRow } from './update-observations.ts';

// Each paired System's Services: its Service records, and the Services an open
// Service down Condition or Service restarted note names after their record went.
export const serviceSubjects = (sql: SQL) => sql`
  SELECT r.system, r.name FROM mirrored_records r
  JOIN paired_systems p ON p.system = r.system
  WHERE r.kind = 'service'
  UNION
  SELECT c.system, c.subject AS name FROM conditions c
  JOIN paired_systems p ON p.system = c.system
  WHERE c.kind IN ('service_down', 'service_restarted') AND c.cleared_at IS NULL
`;

type ServiceRow = UpstreamCheckRow & {
  checks_received_at: Date | null;
  down_since: Date | null;
  last_seen_at: Date | null;
  latest_stop_at: Date | null;
  name: string;
  restarted: boolean;
  services: ChecksRow['services'];
  sleeps: boolean | null;
  system: string;
  version: string | null;
  upstream: string | null;
  observations: unknown[] | null;
  // When each newest release of its upstream was first found, oldest first.
  found: UpstreamRelease[] | null;
  // Each upstream it has had, from when, oldest first.
  history: { at: number; upstream: string | null }[] | null;
};

// Held checks say a Service is up only while its System is heard from and the
// checks are not old beside its Last seen, the rule that raises checks missing.
const currentChecks = (row: ServiceRow, now: number): boolean =>
  row.last_seen_at !== null &&
  row.checks_received_at !== null &&
  now - row.last_seen_at.getTime() <= QUIET_AFTER_MS &&
  row.last_seen_at.getTime() - row.checks_received_at.getTime() <= OLD_EVIDENCE_MS;

// Recorded Services and open Service Conditions on paired Systems, with checks and latest
// stop, installed version, available update, and what dates that update, in one statement.
//
// `dated` reads what dates an available update: when each release of the
// Service's upstream was found, and each upstream it has had. Without it both
// come back null, so a caller that shows no date reads no history.
const readServiceRows = (sql: SQL, { dated }: { dated: boolean }): Promise<ServiceRow[]> => sql`
    SELECT r.system, r.name, c.services, c.received_at AS checks_received_at, s.last_seen_at, s.sleeps,
           down.raised_at AS down_since,
           EXISTS (
             SELECT 1 FROM conditions n
             WHERE n.system = r.system AND n.subject = r.name
               AND n.kind = 'service_restarted' AND n.cleared_at IS NULL
           ) AS restarted,
           stop.stopped_at AS latest_stop_at, installed.version, installed.upstream,
           upstream.releases, upstream.checked_at, upstream.succeeded_at, upstream.failure,
           managers.observations, found.found, history.history
    FROM (${serviceSubjects(sql)}) r
    LEFT JOIN systems s ON s.name = r.system
    LEFT JOIN check_sets c ON c.system = r.system
    LEFT JOIN LATERAL (
      SELECT raised_at FROM conditions
      WHERE system = r.system AND subject = r.name
        AND kind = 'service_down' AND cleared_at IS NULL
      ORDER BY raised_at DESC LIMIT 1
    ) down ON true
    LEFT JOIN LATERAL (
      SELECT stopped_at FROM service_stops
      WHERE system = r.system AND service = r.name
      ORDER BY stopped_at DESC LIMIT 1
    ) stop ON true
    LEFT JOIN LATERAL (
      SELECT version, upstream FROM service_versions
      WHERE system = r.system AND service = r.name
      ORDER BY first_seen_at DESC LIMIT 1
    ) installed ON true
    LEFT JOIN upstream_checks upstream ON upstream.upstream = installed.upstream
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(observation ORDER BY manager, installation) AS observations
      FROM update_managers
      WHERE system = r.system AND NOT withdrawn
        AND manager = CASE
          WHEN installed.upstream LIKE 'apt:%' THEN 'apt'
          WHEN installed.upstream LIKE 'brew:%' THEN 'homebrew'
        END
    ) managers ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
               jsonb_build_object('at', (extract(epoch FROM first_found_at) * 1000)::bigint, 'version', version)
               ORDER BY first_found_at, version
             ) AS found
      FROM upstream_releases
      WHERE ${dated} AND upstream = installed.upstream
    ) found ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(
               jsonb_build_object('at', (extract(epoch FROM first_seen_at) * 1000)::bigint, 'upstream', upstream)
               ORDER BY first_seen_at
             ) AS history
      FROM service_versions
      WHERE ${dated} AND system = r.system AND service = r.name
    ) history ON true
  `;

// A row's checks of its own Service, however old.
const heldChecks = (row: ServiceRow) =>
  (row.services ?? []).filter(({ service }) => service === row.name);

// Each Service's status, latest stop, installed version, and available update,
// read in one statement from one snapshot.
export const readServices = async (sql: SQL, now = Date.now()): Promise<ServiceSummary[]> => {
  const rows = await readServiceRows(sql, { dated: false });
  return sortServices(
    rows.map((row) => {
      const downSince = row.down_since?.getTime();
      const { status: update } = serviceUpdate({
        check: upstreamCheckOf(row),
        now,
        observations: parseUpdateObservations(row.observations ?? []),
        upstream: row.upstream,
        version: row.version,
      });
      return {
        downSince,
        latestStopAt: row.latest_stop_at?.getTime(),
        name: row.name,
        status: serviceStatus({
          checks: currentChecks(row, now) ? heldChecks(row) : [],
          downSince,
          restarted: row.restarted,
        }),
        system: row.system,
        update: update?.kind === 'update' ? update.version : undefined,
        version: row.version,
      };
    }),
  );
};

// How many of each paired System's Services are up, out of all it has, by
// `countsAsUp`.
const serviceCountsOf = (rows: readonly ServiceRow[], now: number) => {
  const counts = new Map<string, { total: number; up: number }>();
  for (const row of rows) {
    const up = countsAsUp({
      asleep: isAsleep(
        { lastSeenAt: row.last_seen_at?.getTime(), sleeps: row.sleeps === true },
        now,
      ),
      current: currentChecks(row, now),
      down: row.down_since !== null,
      held: heldChecks(row),
    });
    const held = counts.get(row.system) ?? { total: 0, up: 0 };
    counts.set(row.system, { total: held.total + 1, up: held.up + (up ? 1 : 0) });
  }
  return counts;
};

// Each Service with an available update, as the Services page finds it.
const availableUpdatesOf = (rows: readonly ServiceRow[], now: number): AvailableUpdate[] =>
  rows.flatMap((row) => {
    const { status } = serviceUpdate({
      check: upstreamCheckOf(row),
      now,
      observations: parseUpdateObservations(row.observations ?? []),
      releases: row.found ?? [],
      upstream: row.upstream,
      upstreamSince: upstreamSince(row.history ?? []),
      version: row.version,
    });
    return status?.kind === 'update'
      ? [
          {
            name: row.name,
            since: status.source === 'upstream' ? status.since : undefined,
            system: row.system,
            version: status.version,
          },
        ]
      : [];
  });

// How many of each paired System's Services are up, out of all it has, and
// each Service with an available update, from one statement.
export const readServiceGlance = async (
  sql: SQL,
  now: number,
): Promise<{ counts: Map<string, { total: number; up: number }>; updates: AvailableUpdate[] }> => {
  const rows = await readServiceRows(sql, { dated: true });
  return { counts: serviceCountsOf(rows, now), updates: availableUpdatesOf(rows, now) };
};

// Count Services once even when both Service down and Service restarted are open.
export const readServiceAttentionCount = async (sql: SQL): Promise<number> => {
  const [row]: { count: number }[] = await sql`
    SELECT count(*)::integer AS count
    FROM (${serviceSubjects(sql)}) r
    WHERE EXISTS (
      SELECT 1 FROM conditions c
      WHERE c.system = r.system AND c.subject = r.name
        AND c.kind IN ('service_down', 'service_restarted') AND c.cleared_at IS NULL
    )
  `;
  return row?.count ?? 0;
};
