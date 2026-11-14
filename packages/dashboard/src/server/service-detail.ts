import type { SQL } from 'bun';

import { historyFrom, stopSpan } from '../lib/service-availability.ts';
import { installsOf } from '../lib/service-installs.ts';
import {
  isCheckedUpstream,
  isPackageUpstream,
  serviceUpdate,
  updatesOf,
  upstreamSince,
} from '../lib/service-updates.ts';
import { aroundSpan } from '../lib/vitals-window.ts';
import { readConditionLimits } from './condition-limits.ts';
import { BUCKET_MS } from './fleet-overview.ts';
import { field, text } from './hub-rows.ts';
import type { ChecksRow, RecordRow } from './hub-rows.ts';
import type { ServiceDetail, ServiceDownTransition, ServiceStop } from './service-detail-types.ts';
import { readServiceStops } from './service-stops.ts';
import { recordedService } from './system-detail.ts';
import { parseUpdateObservations, upstreamCheckOf } from './update-observations.ts';
import type { UpstreamCheckRow } from './update-observations.ts';
import { readPlatform, readVitalsWindow } from './vitals-window.ts';

const nameField = (input: unknown, key: string, what: string): string => {
  const name = field(input, key);
  if (typeof name !== 'string' || name === '') {
    throw new Error(`The request names no ${what}.`);
  }
  return name;
};

// The System and Service a Service page asks for, and the stop it selects: the
// time it stopped, in epoch milliseconds. Without one, the newest stop is selected.
export const parseServiceDetailInput = (
  input: unknown,
): { name: string; service: string; stop: number | undefined } => {
  const stop = field(input, 'stop');
  return {
    name: nameField(input, 'name', 'System'),
    service: nameField(input, 'service', 'Service'),
    stop: typeof stop === 'number' && Number.isSafeInteger(stop) ? stop : undefined,
  };
};

// The spans in which the System sent Vitals since `historyFrom(now)`: each run
// of 5-minute rollups with none missing, from the first one's start to the
// last one's end. The strip bins them into days in the viewer's zone. The
// rollups are 288 a day at most, so the read follows the window and not the
// Vitals the Hub keeps.
const readReported = async (
  sql: SQL,
  { now, system }: { now: number; system: string },
): Promise<{ from: number; to: number }[]> => {
  const rows: { first: Date; last: Date }[] = await sql`
    SELECT min(bucket) AS first, max(bucket) AS last
    FROM (
      SELECT bucket,
             bucket - row_number() OVER (ORDER BY bucket) * make_interval(secs => ${BUCKET_MS / 1000}) AS run
      FROM vitals_rollups
      WHERE system = ${system} AND bucket >= ${new Date(historyFrom(now))} AND bucket < ${new Date(now)}
    ) buckets
    GROUP BY run
    ORDER BY 1
  `;
  return rows.map(({ first, last }) => ({
    from: first.getTime(),
    to: Math.min(now, last.getTime() + BUCKET_MS),
  }));
};

// The stop the page selects: the one that began at `stop`, else the newest, and
// the System's Vitals around it. Undefined when the Service has no stop.
const readSelection = async (
  sql: SQL,
  {
    now,
    stop,
    stops,
    system,
  }: { now: number; stop: number | undefined; stops: readonly ServiceStop[]; system: string },
): Promise<ServiceDetail['selection']> => {
  const found = stops.find((candidate) => Date.parse(candidate.stoppedAt) === stop) ?? stops[0];
  if (found === undefined) {
    return undefined;
  }
  const span = stopSpan(found, now);
  const [limits, platform] = await Promise.all([
    readConditionLimits(sql, system),
    readPlatform(sql, system),
  ]);
  const vitals = await readVitalsWindow(sql, {
    ...aroundSpan(span, now),
    limits,
    now,
    platform,
    system,
  });
  return { span, vitals };
};

// Where a Service record puts the Service under its supervisor.
const unitOf = (record: Record<string, unknown>): string | undefined =>
  text(record.unit) ?? text(record.container) ?? text(record.label);

// One Service of System `system` as of `now`: its record and checks, the open
// Service restarted note, the stops of the last 90 days, the raises and clears
// of each Service down open in them, the spans the System sent Vitals, the
// selected stop with the Vitals around it, the installed version and its
// changes, and upstream updates, from one snapshot.
// A System that is no longer paired opens as it was left. Undefined for a
// System that does not exist, and for a Service with no record, stop, Service
// down in its history, or open Service Condition.
export const readServiceDetail = (
  sql: SQL,
  {
    now,
    service,
    stop,
    system,
  }: { now: number; service: string; stop?: number | undefined; system: string },
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
      // Every Service down open in the strip's days, with its raise however
      // long ago, as a stop still under way stays.
      tx`
        SELECT t.condition, t.action, t.at, t.reason
        FROM condition_transitions t
        JOIN conditions c ON c.id = t.condition
        WHERE c.system = ${system} AND c.kind = 'service_down' AND c.subject = ${service}
          AND t.action IN ('raised', 'cleared')
          AND (c.cleared_at IS NULL OR c.cleared_at >= ${new Date(historyFrom(now))})
        ORDER BY t.id
      `,
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
    const upstream = latest?.upstream ?? null;
    const remote = isCheckedUpstream(upstream);
    const [upstreamChecks, releases, managers]: [
      UpstreamCheckRow[],
      { first_found_at: Date; version: string }[],
      { observation: unknown }[],
    ] = await Promise.all([
      remote
        ? tx`SELECT checked_at, failure, releases, succeeded_at FROM upstream_checks WHERE upstream = ${upstream}`
        : [],
      remote
        ? tx`SELECT version, first_found_at FROM upstream_releases WHERE upstream = ${upstream} ORDER BY first_found_at, version`
        : [],
      isPackageUpstream(upstream)
        ? tx`SELECT observation FROM update_managers WHERE system = ${system} AND NOT withdrawn ORDER BY manager, installation`
        : [],
    ]);
    const check = upstreamChecks[0];
    const releaseRows = releases.map(({ first_found_at, version }) => ({
      at: first_found_at.getTime(),
      version,
    }));
    const versionRows = versions.map(({ first_seen_at, upstream: installedUpstream, version }) => ({
      at: first_seen_at.getTime(),
      upstream: installedUpstream,
      version,
    }));
    const [reported, selection] = await Promise.all([
      readReported(tx, { now, system }),
      readSelection(tx, { now, stop, stops, system }),
    ]);
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
      installs: installsOf(versionRows, now),
      note:
        note === undefined
          ? undefined
          : { id: note.id, raisedAt: note.raised_at.getTime(), reason: note.latest_reason },
      now,
      recorded:
        record === undefined
          ? undefined
          : recordedService(service, record, checks[0]?.services ?? []),
      reported,
      selection,
      service,
      stops,
      system,
      unit: record === undefined ? undefined : unitOf(record),
      update: serviceUpdate({
        check: upstreamCheckOf(check),
        now,
        observations: parseUpdateObservations(managers.map(({ observation }) => observation)),
        releases: releaseRows,
        upstream,
        upstreamSince: upstreamSince(versionRows),
        version: latest?.version ?? null,
      }),
      updates: updatesOf({ now, releases: releaseRows, upstream, versions: versionRows }),
    };
  });
