import type { SQL } from 'bun';

import { field, text } from './hub-rows.ts';
import type { ChecksRow, RecordRow } from './hub-rows.ts';
import type { ServiceDetail } from './service-detail-types.ts';
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

// Where a Service record puts the Service under its supervisor.
const unitOf = (record: Record<string, unknown>): string | undefined =>
  text(record.unit) ?? text(record.container) ?? text(record.label);

// One Service of System `system` as of `now`: its record and checks, the open
// Service restarted note, and the stops of the last 90 days, from one snapshot.
// A System that is no longer paired opens as it was left. Undefined for a
// System that does not exist, and for a Service with neither a record nor a stop.
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
    const [records, checks, notes, stops]: [
      RecordRow[],
      Pick<ChecksRow, 'services'>[],
      { id: string; latest_reason: string; raised_at: Date }[],
      Awaited<ReturnType<typeof readServiceStops>>,
    ] = await Promise.all([
      tx`
        SELECT kind, name, record FROM mirrored_records
        WHERE system = ${system} AND kind = 'service' AND name = ${service}
      `,
      tx`SELECT services FROM check_sets WHERE system = ${system}`,
      tx`
        SELECT id, raised_at, latest_reason FROM conditions
        WHERE system = ${system} AND kind = 'service_restarted' AND subject = ${service}
          AND cleared_at IS NULL
        ORDER BY id DESC LIMIT 1
      `,
      // Every stop the Hub holds: those of its 90 days, and one still under way
      // however old, which the Hub keeps until it ends.
      readServiceStops(tx, { includeUnpaired: true, service, system }),
    ]);
    const record = records[0]?.record;
    if (record === undefined && stops.length === 0) {
      return undefined;
    }
    const note = notes[0];
    return {
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
