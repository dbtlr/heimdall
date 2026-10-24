import type { ServiceStopsRead } from '@heimdall/schema';
import type { SQL } from 'bun';

import { plain, UNAVAILABLE, unpairedParam } from './read-answer.ts';

type Stop = ServiceStopsRead['stops'][number];

type StopRow = {
  exit_status: number | null;
  ongoing: boolean;
  paired: boolean;
  received_at: Date;
  restarts: number;
  result: string | null;
  sent_at: Date;
  service: string;
  started_at: Date | null;
  stopped_at: Date;
  system: string;
};

// Stops are observations, read apart from provisioner records (ADR-0011).
export const readServiceStops = async (
  sql: SQL,
  {
    includeUnpaired,
    service,
    since,
    system,
  }: {
    includeUnpaired: boolean;
    service?: string;
    since?: Date;
    system?: string;
  },
): Promise<Stop[]> => {
  const rows: StopRow[] = await sql`
    SELECT s.*, p.system IS NOT NULL AS paired
    FROM service_stops s
    LEFT JOIN paired_systems p ON p.system = s.system
    WHERE (${includeUnpaired} OR p.system IS NOT NULL)
      AND (${system ?? null}::text IS NULL OR s.system = ${system ?? null})
      AND (${service ?? null}::text IS NULL OR s.service = ${service ?? null})
      AND (${since ?? null}::timestamptz IS NULL OR s.stopped_at >= ${since ?? null})
    ORDER BY s.system COLLATE "C", s.service COLLATE "C", s.stopped_at DESC
  `;
  return rows.map((row) => ({
    exitStatus: row.exit_status,
    ongoing: row.ongoing,
    paired: row.paired,
    receivedAt: row.received_at.toISOString(),
    restarts: row.restarts,
    result: row.result,
    sentAt: row.sent_at.toISOString(),
    service: row.service,
    startedAt: row.started_at?.toISOString() ?? null,
    stoppedAt: row.stopped_at.toISOString(),
    system: row.system,
  }));
};

// A date, `T`, and a time to the minute or second with optional fractions,
// then `Z` or an offset.
const ISO_TIME =
  /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// `since` as an instant, or undefined unless it is an ISO_TIME whose date and
// hour exist: Date.parse alone rolls 2026-02-30 over to March and 24:00 over
// to the next day.
const sinceOf = (value: string): Date | undefined => {
  const match = ISO_TIME.exec(value);
  const at = Date.parse(value);
  if (match === null || !Number.isFinite(at)) {
    return undefined;
  }
  const [year, month, day, hour] = match.slice(1, 5).map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined) {
    return undefined;
  }
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  const exists = calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day && hour < 24;
  return exists ? new Date(at) : undefined;
};

// Database failures answer 503 and reach the dashboard's error log.
export const serviceStopsAnswer = async ({
  database,
  onError,
  url,
}: {
  database: () => Promise<SQL>;
  onError: (error: unknown) => void;
  url: URL;
}): Promise<Response> => {
  const unpaired = unpairedParam(url);
  if (unpaired instanceof Response) {
    return unpaired;
  }
  for (const name of ['system', 'service', 'since']) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1 || values.some((value) => value === '')) {
      return plain(400, `Give ${name} once, with a non-empty value.`);
    }
  }
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam === null ? undefined : sinceOf(sinceParam);
  if (sinceParam !== null && since === undefined) {
    return plain(400, 'Give since as an ISO 8601 date and time, such as 2026-10-24T07:40:05Z.');
  }
  const system = url.searchParams.get('system');
  const service = url.searchParams.get('service');
  try {
    const stops = await readServiceStops(await database(), {
      includeUnpaired: unpaired,
      ...(service === null ? {} : { service }),
      ...(since === undefined ? {} : { since }),
      ...(system === null ? {} : { system }),
    });
    return Response.json({ stops });
  } catch (error) {
    onError(error);
    return plain(503, UNAVAILABLE);
  }
};
