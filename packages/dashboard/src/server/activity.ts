import { ConditionLevelSchema } from '@heimdall/schema';
import type { SQL } from 'bun';

import { shownElsewhere } from '../lib/attention.ts';
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

type ConditionRow = {
  cleared_at: Date | null;
  id: string;
  kind: string;
  latest_reason: string;
  level: string;
  raised_at: Date;
  subject: string;
  system: string;
};

type DeliveryRow = {
  closed_at: Date | null;
  kind: string;
  pushed_at: Date;
  subject: string;
  system: string;
};

// A Condition occurrence is listed when it was raised in the window, at its
// raising, or, raised before the window, when it was cleared in it, at its
// clearing. Maintenance notes and Service restarted notes on paired Systems
// are left out, as they live on Maintenance and Services.
const conditionEvents = (
  rows: readonly ConditionRow[],
  { from, paired }: { from: number; paired: ReadonlySet<string> },
): ConditionActivity[] =>
  rows.flatMap((row): ConditionActivity[] => {
    const condition = conditionKind(row.kind);
    const level = ConditionLevelSchema.parse(row.level);
    if (
      shownElsewhere({ kind: condition, level, unpaired: !paired.has(row.system) }) !== undefined
    ) {
      return [];
    }
    const raisedAt = row.raised_at.getTime();
    const raisedInWindow = raisedAt >= from;
    const clearedAt = row.cleared_at?.getTime();
    return [
      {
        action: raisedInWindow ? 'raised' : 'cleared',
        at: raisedInWindow ? raisedAt : (clearedAt ?? raisedAt),
        clearedAt,
        condition,
        conditionId: row.id,
        kind: condition === 'drift' ? 'drift' : 'condition',
        level,
        reason: row.latest_reason,
        subject: row.subject,
        system: row.system,
      },
    ];
  });

// Alerts pushed in the window, each with the recovery sent when it closed on
// a paired System, which sends none once unpaired.
const alertEvents = (rows: readonly DeliveryRow[], paired: ReadonlySet<string>): AlertActivity[] =>
  rows.map((row) => ({
    at: row.pushed_at.getTime(),
    condition: conditionKind(row.kind),
    kind: 'alert',
    open: row.closed_at === null,
    recoveredAt: paired.has(row.system) ? row.closed_at?.getTime() : undefined,
    subject: row.subject,
    system: row.system,
  }));

// Every change in the range that ends at `now`: Condition occurrences, Service
// version changes and stops, Drift, and alerts sent, on paired Systems and on
// unpaired ones, whose history is kept. Each read is bounded by the window.
// Changes to recorded files and Harness installs are not listed, as neither
// keeps a history.
export const readActivity = (
  sql: SQL,
  { now, range }: { now: number; range: ActivityRange },
): Promise<Activity> => {
  const from = now - ACTIVITY_RANGE_MS[range];
  const [start, end] = [new Date(from), new Date(now)];
  return sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
    const [conditions, deliveries, pairings, services]: [
      ConditionRow[],
      DeliveryRow[],
      { system: string }[],
      Awaited<ReturnType<typeof readServiceChanges>>,
    ] = await Promise.all([
      tx`
        SELECT id::text AS id, system, kind, level, subject, raised_at, cleared_at, latest_reason
        FROM conditions
        WHERE (raised_at >= ${start} AND raised_at <= ${end})
           OR (cleared_at >= ${start} AND cleared_at <= ${end})
      `,
      tx`
        SELECT system, kind, subject, pushed_at, closed_at
        FROM deliveries
        WHERE pushed_at >= ${start} AND pushed_at <= ${end}
      `,
      tx`SELECT system FROM paired_systems`,
      readServiceChanges(tx, { includeUnpaired: true, now, since: from }),
    ]);
    const paired = new Set(pairings.map(({ system }) => system));
    const events: ActivityEvent[] = [
      ...conditionEvents(conditions, { from, paired }),
      ...alertEvents(deliveries, paired),
      ...services,
    ];
    const systems = new Set([...paired, ...events.map(({ system }) => system)]);
    return {
      events,
      from,
      now,
      range,
      systems: [...systems].toSorted((a, b) => a.localeCompare(b)),
      unpaired: [...systems].filter((system) => !paired.has(system)).toSorted(),
    };
  });
};
