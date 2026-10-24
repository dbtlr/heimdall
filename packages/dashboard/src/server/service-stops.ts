import type { ServiceStopsRead } from '@heimdall/schema';
import type { SQL } from 'bun';

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

const plain = (status: number, body: string) =>
  new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' }, status });

const ISO_TIME =
  /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

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
  const unpaired = url.searchParams.getAll('unpaired');
  if (unpaired.some((value) => value !== 'include')) {
    return plain(400, 'The only value for unpaired is include: ?unpaired=include.');
  }
  for (const name of ['system', 'service', 'since']) {
    const values = url.searchParams.getAll(name);
    if (values.length > 1 || values.some((value) => value === '')) {
      return plain(400, `Give ${name} once, with a non-empty value.`);
    }
  }
  const since = url.searchParams.get('since');
  if (since !== null && (!ISO_TIME.test(since) || !Number.isFinite(Date.parse(since)))) {
    return plain(400, 'Give since as an ISO 8601 time.');
  }
  const system = url.searchParams.get('system');
  const service = url.searchParams.get('service');
  try {
    const stops = await readServiceStops(await database(), {
      includeUnpaired: unpaired.length > 0,
      ...(service === null ? {} : { service }),
      ...(since === null ? {} : { since: new Date(since) }),
      ...(system === null ? {} : { system }),
    });
    return Response.json({ stops });
  } catch (error) {
    onError(error);
    return plain(503, 'The dashboard cannot answer right now; try again later.');
  }
};
