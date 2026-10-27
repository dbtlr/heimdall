import type { SQL } from 'bun';

import { installsOf } from '../lib/service-installs.ts';
import { field, text } from './hub-rows.ts';
import type { ChecksRow, RecordRow } from './hub-rows.ts';
import type { ServiceDetail, ServiceDownTransition } from './service-detail-types.ts';
import { readServiceStops } from './service-stops.ts';
import { recordedService } from './system-detail.ts';

const nameField = (input: unknown, key: string, what: string): string => {
  const name = field(input, key);
  if (typeof name !== 'string' || name === '') {
    throw new Error(`The request names no ${what}.`);
  }
  return name;
};

// The System and Service a Service page asks for.
export const parseServiceDetailInput = (input: unknown): { name: string; service: string } => ({
  name: nameField(input, 'name', 'System'),
  service: nameField(input, 'service', 'Service'),
});

// The Hub keeps stops for this long, and the Service page's history reaches back as far.
const HISTORY_MS = 90 * 24 * 60 * 60 * 1000;

// Where a Service record puts the Service under its supervisor.
const unitOf = (record: Record<string, unknown>): string | undefined =>
  text(record.unit) ?? text(record.container) ?? text(record.label);

// One Service of System `system` as of `now`: its record and checks, the open
// Service restarted note, the stops and Service down raises and clears of the
// last 90 days, and the installed version and its changes, from one snapshot.
// A System that is no longer paired opens as it was left. Undefined for a
// System that does not exist, and for a Service with no record, stop, Service
// down in its history, or open Service Condition.
export const readServiceDetail = (
  sql: SQL,
  { now, service, system }: { now: number; service: string; system: string },
): Promise<ServiceDetail | undefined> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const [known]: { name: string }[] = await tx`
      SELECT name FROM systems WHERE name = ${system}
      UNION
      SELECT system AS name FROM paired_systems WHERE system = ${system}
    `;
    if (known === undefined) {
      return undefined;
    }
    const [records, checks, conditions, stops, downs, versions, applications]: [
      RecordRow[],
      Pick<ChecksRow, 'services'>[],
      { id: string; kind: string; latest_reason: string; raised_at: Date }[],
      Awaited<ReturnType<typeof readServiceStops>>,
      { action: ServiceDownTransition['kind']; at: Date; condition: string; reason: string }[],
      { first_seen_at: Date; upstream: string | null; version: string | null }[],
      { name: string }[],
    ] = await Promise.all([
      tx`
        SELECT kind, name, record FROM mirrored_records
        WHERE system = ${system} AND kind = 'service' AND name = ${service}
      `,
      tx`SELECT services FROM check_sets WHERE system = ${system}`,
      tx`
        SELECT id, kind, raised_at, latest_reason FROM conditions
        WHERE system = ${system} AND kind IN ('service_down', 'service_restarted') AND subject = ${service}
          AND cleared_at IS NULL
        ORDER BY id DESC
      `,
      // Every stop the Hub holds: those of its 90 days, and one still under way
      // however old, which the Hub keeps until it ends.
      readServiceStops(tx, { includeUnpaired: true, service, system }),
      // A Service down still open stays however long ago it was raised, as a
      // stop still under way does.
      tx`
        SELECT t.condition, t.action, t.at, t.reason
        FROM condition_transitions t
        JOIN conditions c ON c.id = t.condition
        WHERE c.system = ${system} AND c.kind = 'service_down' AND c.subject = ${service}
          AND t.action IN ('raised', 'cleared')
          AND (t.at >= ${new Date(now - HISTORY_MS)} OR (t.action = 'raised' AND c.cleared_at IS NULL))
        ORDER BY t.id
      tx`
        SELECT version, upstream, first_seen_at FROM service_versions
        WHERE system = ${system} AND service = ${service}
        ORDER BY first_seen_at
      `,
      tx`
        SELECT name FROM mirrored_records
        WHERE system = ${system} AND kind = 'application'
      `,
    ]);
    const record = records[0]?.record;
    if (
      record === undefined &&
      stops.length === 0 &&
      conditions.length === 0 &&
      downs.length === 0
    ) {
      return undefined;
    }
    const note = conditions.find(({ kind }) => kind === 'service_restarted');
    const latest = versions.at(-1);
    const application = text(record?.application);
    return {
      downs: downs.map((row) => ({
        at: row.at.getTime(),
        condition: row.condition,
        kind: row.action,
        reason: row.reason,
      })),
      installed: {
        missingApplication:
          application !== undefined && !applications.some(({ name }) => name === application)
            ? application
            : undefined,
        upstream: latest?.upstream ?? null,
        version: latest?.version ?? null,
      },
      installs: installsOf(
        versions.map(({ first_seen_at, version }) => ({ at: first_seen_at.getTime(), version })),
        now,
      ),
      note:
        note === undefined
          ? undefined
          : { id: note.id, raisedAt: note.raised_at.getTime(), reason: note.latest_reason },
      now,
      recorded:
        record === undefined
          ? undefined
          : recordedService(service, record, checks[0]?.services ?? []),
      service,
      stops,
      system,
      unit: record === undefined ? undefined : unitOf(record),
    };
  });
