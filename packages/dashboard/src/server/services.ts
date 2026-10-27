import type { SQL } from 'bun';

import { serviceUpdate } from '../lib/service-updates.ts';
import { serviceStatus, sortServices } from '../lib/services.ts';
import type { ServiceSummary } from '../lib/services.ts';
import { OLD_EVIDENCE_MS } from './attention-types.ts';
import { QUIET_AFTER_MS } from './fleet-overview-types.ts';
import type { ChecksRow } from './hub-rows.ts';
import { parseUpdateObservations, upstreamCheckOf } from './update-observations.ts';
import type { UpstreamCheckRow } from './update-observations.ts';

const serviceSubjects = (sql: SQL) => sql`
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
  system: string;
  version: string | null;
  upstream: string | null;
  observations: unknown[] | null;
};

// Held checks say a Service is up only while its System is heard from and the
// checks are not old beside its Last seen, the rule that raises checks missing.
const currentChecks = (row: ServiceRow, now: number): boolean =>
  row.last_seen_at !== null &&
  row.checks_received_at !== null &&
  now - row.last_seen_at.getTime() <= QUIET_AFTER_MS &&
  row.last_seen_at.getTime() - row.checks_received_at.getTime() <= OLD_EVIDENCE_MS;

// Recorded Services and open Service Conditions on paired Systems, with checks and latest
// stop, installed version, and available update read in one statement from one snapshot.
export const readServices = async (sql: SQL, now = Date.now()): Promise<ServiceSummary[]> => {
  const rows: ServiceRow[] = await sql`
    SELECT r.system, r.name, c.services, c.received_at AS checks_received_at, s.last_seen_at, down.raised_at AS down_since,
           EXISTS (
             SELECT 1 FROM conditions n
             WHERE n.system = r.system AND n.subject = r.name
               AND n.kind = 'service_restarted' AND n.cleared_at IS NULL
           ) AS restarted,
           stop.stopped_at AS latest_stop_at, installed.version, installed.upstream,
           upstream.releases, upstream.checked_at, upstream.succeeded_at, upstream.failure,
           managers.observations
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
        AND (installed.upstream LIKE 'apt:%' OR installed.upstream LIKE 'brew:%')
    ) managers ON true
  `;
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
          checks: currentChecks(row, now)
            ? (row.services ?? []).filter(({ service }) => service === row.name)
            : [],
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
