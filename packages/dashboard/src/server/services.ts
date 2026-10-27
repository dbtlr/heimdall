import type { SQL } from 'bun';

import { serviceStatus, sortServices } from '../lib/services.ts';
import type { ServiceSummary } from '../lib/services.ts';
import { QUIET_AFTER_MS } from './fleet-overview-types.ts';
import type { ChecksRow } from './hub-rows.ts';

const serviceSubjects = (sql: SQL) => sql`
  SELECT r.system, r.name FROM mirrored_records r
  JOIN paired_systems p ON p.system = r.system
  WHERE r.kind = 'service'
  UNION
  SELECT c.system, c.subject AS name FROM conditions c
  JOIN paired_systems p ON p.system = c.system
  WHERE c.kind IN ('service_down', 'service_restarted') AND c.cleared_at IS NULL
`;

type ServiceRow = {
  down_since: Date | null;
  last_seen_at: Date | null;
  latest_stop_at: Date | null;
  name: string;
  restarted: boolean;
  services: ChecksRow['services'];
  system: string;
};

// Recorded Services and open Service Conditions on paired Systems, with checks and latest
// stop read in one statement so each row describes the same snapshot.
export const readServices = async (sql: SQL, now = Date.now()): Promise<ServiceSummary[]> => {
  const rows: ServiceRow[] = await sql`
    SELECT r.system, r.name, c.services, s.last_seen_at, down.raised_at AS down_since,
           EXISTS (
             SELECT 1 FROM conditions n
             WHERE n.system = r.system AND n.subject = r.name
               AND n.kind = 'service_restarted' AND n.cleared_at IS NULL
           ) AS restarted,
           stop.stopped_at AS latest_stop_at
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
  `;
  return sortServices(
    rows.map((row) => {
      const downSince = row.down_since?.getTime();
      return {
        downSince,
        latestStopAt: row.latest_stop_at?.getTime(),
        name: row.name,
        status: serviceStatus({
          checks:
            row.last_seen_at !== null && now - row.last_seen_at.getTime() <= QUIET_AFTER_MS
              ? (row.services ?? []).filter(({ service }) => service === row.name)
              : [],
          downSince,
          restarted: row.restarted,
        }),
        system: row.system,
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
