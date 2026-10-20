import {
  ConditionLevelSchema,
  parseProcessSubject,
  parseUpdateSubject,
  PendingUpdateSchema,
} from '@heimdall/schema';
import type { ConditionLimitSet, ConditionKind } from '@heimdall/schema';
import type { SQL } from 'bun';

import { readAttention } from './attention.ts';
import type { ConditionDetail, ConditionSeries, PendingPackage } from './condition-detail-types.ts';
import { readConditionTransitions } from './condition-transitions.ts';
import { bucketStart } from './fleet-overview.ts';
import { conditionKind, field } from './hub-rows.ts';

const DAY_MS = 24 * 60 * 60_000;

// The Hub numbers occurrences with a bigint; this many digits always fit one.
const MAX_ID_DIGITS = 18;

// The System and occurrence a Condition page asks for.
export const parseConditionDetailInput = (input: unknown): { name: string; id: string } => {
  const name = field(input, 'name');
  if (typeof name !== 'string' || name === '') {
    throw new Error('The request names no System.');
  }
  const id = field(input, 'id');
  if (typeof id !== 'string' || !new RegExp(`^\\d{1,${MAX_ID_DIGITS}}$`, 'u').test(id)) {
    throw new Error(`The Condition ${JSON.stringify(id)} is not an occurrence number.`);
  }
  return { id, name };
};

type OccurrenceRow = {
  cleared_at: Date | null;
  id: string;
  kind: string;
  latest_at: Date;
  latest_reason: string;
  level: string;
  raised_at: Date;
  subject: string;
};

// `cleared` when the window ends at the occurrence's clearing.
type Window = { cleared: boolean; from: number; to: number };

// The chart's window: 7 days of disk history, 24 hours of anything else.
const windowOf = (kind: ConditionKind, to: number, cleared: boolean): Window => ({
  cleared,
  from: to - (kind === 'low_disk' ? 7 * DAY_MS : DAY_MS),
  to,
});

// Readings whose bucket starts within the window; the first rollup bucket
// fetched may begin before it. A cleared window also leaves out the bucket it
// cleared in, which can hold readings from after the clearing.
const withinWindow = <Row extends { bucket: Date }>(rows: Row[], { cleared, from, to }: Window) =>
  rows.filter(
    (row) => row.bucket.getTime() >= from && (!cleared || row.bucket.getTime() < bucketStart(to)),
  );

// Rollup buckets overlapping the window: the one holding `from` through the
// one holding `to`.
const bucketsIn = ({ from, to }: Window) => [new Date(bucketStart(from)), new Date(to)] as const;

const diskSeries = async (
  sql: SQL,
  { mount, system, window }: { mount: string; system: string; window: Window },
): Promise<ConditionSeries> => {
  const [first, last] = bucketsIn(window);
  const rows: { bucket: Date; total: number; used: number }[] = await sql`
    SELECT bucket, used_max::float8 AS used, total_max::float8 AS total
    FROM disk_rollups
    WHERE system = ${system} AND mount = ${mount} AND bucket >= ${first} AND bucket <= ${last}
    ORDER BY bucket
  `;
  return {
    kind: 'disk',
    points: withinWindow(rows, window).map((row) => ({
      t: row.bucket.getTime(),
      totalBytes: row.total,
      usedBytes: row.used,
    })),
  };
};

// Busy CPU or used memory as a percentage, averaged over each bucket.
const percentSeries = async (
  sql: SQL,
  { kind, system, window }: { kind: 'high_cpu' | 'high_memory'; system: string; window: Window },
): Promise<ConditionSeries> => {
  const [first, last] = bucketsIn(window);
  const rows: { bucket: Date; percent: number | null }[] =
    kind === 'high_cpu'
      ? await sql`
          SELECT bucket, (cpu_busy_sum / samples)::float8 AS percent
          FROM vitals_rollups
          WHERE system = ${system} AND bucket >= ${first} AND bucket <= ${last}
          ORDER BY bucket
        `
      : await sql`
          SELECT bucket,
                 (memory_used_sum / samples / NULLIF(memory_total_max, 0) * 100)::float8 AS percent
          FROM vitals_rollups
          WHERE system = ${system} AND bucket >= ${first} AND bucket <= ${last}
          ORDER BY bucket
        `;
  return {
    kind: 'percent',
    points: withinWindow(rows, window).map((row) => ({
      percent: row.percent,
      t: row.bucket.getTime(),
    })),
  };
};

// One process lifetime's CPU: the busiest reading in each bucket among the
// samples whose top processes include that boot, PID, start, and name. Buckets
// where it was not among the top have no point.
const coresSeries = async (
  sql: SQL,
  { subject, system, window }: { subject: string; system: string; window: Window },
): Promise<ConditionSeries | undefined> => {
  const identity = parseProcessSubject(subject);
  if (identity === undefined) {
    return undefined;
  }
  const [first, last] = bucketsIn(window);
  const rows: { bucket: Date; cores: number }[] = await sql`
    SELECT date_bin('5 minutes', s.t, timestamptz '2000-01-01 00:00:00+00') AS bucket,
           max((e->>'cpuCores')::float8) AS cores
    FROM vitals_samples s
    CROSS JOIN LATERAL jsonb_array_elements(s.processes->'top') e
    WHERE s.system = ${system} AND s.t >= ${first} AND s.t <= ${last}
      AND s.processes->>'bootId' = ${identity.bootId}
      AND (e->>'pid')::bigint = ${identity.pid}
      AND e->>'start' = ${identity.start}
      AND e->>'name' = ${identity.name}
    GROUP BY 1
    ORDER BY 1
  `;
  return {
    kind: 'cores',
    points: withinWindow(rows, window).map((row) => ({
      cores: row.cores,
      t: row.bucket.getTime(),
    })),
  };
};

// The readings that show a Condition of this kind, or undefined for a kind
// with nothing to chart.
const readSeries = (
  sql: SQL,
  {
    kind,
    subject,
    system,
    window,
  }: { kind: ConditionKind; subject: string; system: string; window: Window },
): Promise<ConditionSeries | undefined> => {
  if (kind === 'low_disk') {
    return diskSeries(sql, { mount: subject, system, window });
  }
  if (kind === 'high_cpu' || kind === 'high_memory') {
    return percentSeries(sql, { kind, system, window });
  }
  if (kind === 'hot_process') {
    return coresSeries(sql, { subject, system, window });
  }
  return Promise.resolve(undefined);
};

// The System's own limits, else the fleet's.
const readLimits = async (sql: SQL, system: string): Promise<ConditionLimitSet | undefined> => {
  const rows: { limits: ConditionLimitSet; system: string }[] = await sql`
    SELECT system, limits FROM condition_limits WHERE system IN (${system}, '')
  `;
  return (rows.find((row) => row.system === system) ?? rows[0])?.limits;
};

// The platform the System's Collector last reported, if any.
const readPlatform = async (sql: SQL, system: string): Promise<string | undefined> => {
  const [row]: { collector_platform: string | null }[] = await sql`
    SELECT collector_platform FROM systems WHERE name = ${system}
  `;
  return row?.collector_platform ?? undefined;
};

// The packages the Hub holds as pending in the package source an open
// pending_update Condition names, security updates first.
const readPackages = async (
  sql: SQL,
  { subject, system }: { subject: string; system: string },
): Promise<PendingPackage[]> => {
  const source = parseUpdateSubject(subject);
  if (source === undefined) {
    return [];
  }
  const rows: { name: string; pending_update: unknown; security_since: Date | null }[] = await sql`
    SELECT name, pending_update, security_since FROM update_subjects
    WHERE system = ${system} AND manager = ${source.manager} AND installation = ${source.installation}
    ORDER BY security_since IS NULL, name
  `;
  return rows.map((row) => {
    const { available, installed, security } = PendingUpdateSchema.parse(row.pending_update);
    return {
      available,
      installed,
      name: row.name,
      security,
      securitySince: row.security_since?.getTime() ?? null,
    };
  });
};

// The open occurrence's attention item, the way the System page builds it.
const readOpenAttention = async (
  sql: SQL,
  { id, name, now }: { id: string; name: string; now: number },
) => {
  const [system]: { paired: boolean }[] = await sql`
    SELECT EXISTS (SELECT 1 FROM paired_systems WHERE system = ${name}) AS paired
  `;
  const items = await readAttention(sql, {
    now,
    systems: [{ name, paired: system?.paired === true }],
  });
  return items.find((item) => item.conditionId === id);
};

// One Condition occurrence of a System, with its Timeline of transitions, the
// evidence and next steps while it is open, the limits the Hub judges by now, and
// the readings around it. Undefined when the System has no such occurrence.
// Read-only.
export const readConditionDetail = async (
  sql: SQL,
  { id, name, now }: { id: string; name: string; now: number },
): Promise<ConditionDetail | undefined> => {
  const [row]: OccurrenceRow[] = await sql`
    SELECT id, kind, subject, level, raised_at, latest_at, latest_reason, cleared_at
    FROM conditions
    WHERE id = ${id}::bigint AND system = ${name}
  `;
  if (row === undefined) {
    return undefined;
  }
  const kind = conditionKind(row.kind);
  const clearedAt = row.cleared_at?.getTime();
  const window = windowOf(kind, clearedAt ?? now, clearedAt !== undefined);
  const [transitions, limits, series, attention, packages, platform] = await Promise.all([
    readConditionTransitions(sql, [row]),
    readLimits(sql, name),
    readSeries(sql, { kind, subject: row.subject, system: name, window }),
    clearedAt === undefined ? readOpenAttention(sql, { id: row.id, name, now }) : undefined,
    clearedAt === undefined && kind === 'pending_update'
      ? readPackages(sql, { subject: row.subject, system: name })
      : undefined,
    readPlatform(sql, name),
  ]);
  return {
    attention,
    clearedAt,
    from: window.from,
    id: row.id,
    kind,
    latestAt: row.latest_at.getTime(),
    latestReason: row.latest_reason,
    level: ConditionLevelSchema.parse(row.level),
    limits,
    packages,
    platform,
    raisedAt: row.raised_at.getTime(),
    series,
    subject: row.subject,
    system: name,
    to: window.to,
    transitions: transitions.get(row.id) ?? [],
  };
};
