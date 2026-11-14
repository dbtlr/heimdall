import { ConditionLevelSchema } from '@heimdall/schema';
import type { ConditionLevel } from '@heimdall/schema';
import type { SQL } from 'bun';

import { shownElsewhere } from '../lib/attention.ts';
import { axisBucketMs, readAxisLanes, readAxisStretches } from './activity-axis.ts';
import { ACTIVITY_RANGE_MS } from './activity-types.ts';
import type {
  Activity,
  ActivityEvent,
  ActivityRange,
  AlertActivity,
  ConditionActivity,
} from './activity-types.ts';
import { readServiceChanges } from './home-cards.ts';
import { conditionKind } from './hub-rows.ts';

type TransitionRow = {
  action: ConditionActivity['action'];
  at: Date;
  cleared_at: Date | null;
  id: string;
  kind: string;
  level: string;
  previous_level: string | null;
  raised_at: Date;
  reason: string;
  subject: string;
  system: string;
};

type DeliveryRow = {
  closed_at: Date | null;
  kind: string;
  pushed_at: Date;
  recovered_at: Date | null;
  subject: string;
  system: string;
};

// Each Condition transition in the window, at the level it left the Condition
// at. A transition that only concerns levels the list keeps off is left out:
// maintenance notes and Service restarted notes on paired Systems, which live
// on Maintenance and Services. A level change into or out of one stays.
const conditionEvents = (
  rows: readonly TransitionRow[],
  paired: ReadonlySet<string>,
): ConditionActivity[] =>
  rows.flatMap((row): ConditionActivity[] => {
    const condition = conditionKind(row.kind);
    const level = ConditionLevelSchema.parse(row.level);
    const previousLevel =
      row.previous_level === null ? undefined : ConditionLevelSchema.parse(row.previous_level);
    const unpaired = !paired.has(row.system);
    const elsewhere = (at: ConditionLevel) =>
      shownElsewhere({ kind: condition, level: at, unpaired }) !== undefined;
    if (elsewhere(level) && (previousLevel === undefined || elsewhere(previousLevel))) {
      return [];
    }
    return [
      {
        action: row.action,
        at: row.at.getTime(),
        condition,
        conditionId: row.id,
        kind: condition === 'drift' ? 'drift' : 'condition',
        level,
        open: row.cleared_at === null,
        previousLevel,
        raisedAt: row.raised_at.getTime(),
        reason: row.reason,
        subject: row.subject,
        system: row.system,
      },
    ];
  });

// Alerts pushed in the window, each with the time its recovered message went
// out, as the Hub recorded it.
const alertEvents = (rows: readonly DeliveryRow[]): AlertActivity[] =>
  rows.map((row) => ({
    at: row.pushed_at.getTime(),
    condition: conditionKind(row.kind),
    kind: 'alert',
    open: row.closed_at === null,
    recoveredAt: row.recovered_at?.getTime(),
    subject: row.subject,
    system: row.system,
  }));

type ActivityInput = { now: number; range: ActivityRange; system?: string | undefined };

// Every change in the range that ends at `now`, in a snapshot `tx` holds:
// Condition transitions, Drift, Service version changes and stops, and alerts
// sent, with each System's CPU and Session stretches for the shared axis, on paired Systems and on unpaired ones, whose history is kept. With
// `system`, that System's alone. Each source is found by time through an
// index, so a read costs what its window holds. Changes to recorded files and
// Harness installs are not listed, as neither keeps a history.
export const readActivitySnapshot = async (
  tx: SQL,
  { now, range, system }: ActivityInput,
): Promise<Activity> => {
  const from = now - ACTIVITY_RANGE_MS[range];
  const [start, end] = [new Date(from), new Date(now)];
  const only = system ?? null;
  const [transitions, deliveries, pairings, services, stretches]: [
    TransitionRow[],
    DeliveryRow[],
    { system: string }[],
    Awaited<ReturnType<typeof readServiceChanges>>,
    Awaited<ReturnType<typeof readAxisStretches>>,
  ] = await Promise.all([
    tx`
      SELECT c.id::text AS id, c.system, c.kind, c.subject, c.raised_at, c.cleared_at,
        t.action, t.level, t.previous_level, t.at, t.reason
      FROM condition_transitions t
      JOIN conditions c ON c.id = t.condition
      WHERE t.at >= ${start} AND t.at <= ${end}
        AND (${only}::text IS NULL OR c.system = ${only})
      ORDER BY t.id
    `,
    tx`
      SELECT system, kind, subject, pushed_at, closed_at, recovered_at
      FROM deliveries
      WHERE pushed_at >= ${start} AND pushed_at <= ${end}
        AND (${only}::text IS NULL OR system = ${only})
    `,
    tx`SELECT system FROM paired_systems`,
    readServiceChanges(tx, {
      includeUnpaired: true,
      now,
      since: from,
      ...(system === undefined ? {} : { system }),
    }),
    readAxisStretches(tx, { from: start, only, to: end }),
  ]);
  const paired = new Set(pairings.map((row) => row.system));
  const events: ActivityEvent[] = [
    ...conditionEvents(transitions, paired),
    ...alertEvents(deliveries),
    ...services,
  ];
  const systems = new Set([
    ...(system === undefined ? paired : []),
    ...events.map((event) => event.system),
    ...stretches.keys(),
  ]);
  const names = [...systems].toSorted((a, b) => a.localeCompare(b));
  const bucketMs = axisBucketMs(now - from);
  return {
    bucketMs,
    events,
    from,
    lanes: await readAxisLanes(tx, { from, stretches, systems: names, to: now, widthMs: bucketMs }),
    now,
    range,
    systems: names,
    unpaired: [...systems].filter((name) => !paired.has(name)).toSorted(),
  };
};

// Every change in the range, read in one snapshot.
export const readActivity = (sql: SQL, input: ActivityInput): Promise<Activity> =>
  sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', (tx) => readActivitySnapshot(tx, input));
