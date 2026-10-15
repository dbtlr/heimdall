import { ConditionLevelSchema } from '@heimdall/schema';
import type { ConditionTransition } from '@heimdall/schema';
import type { SQL } from 'bun';

type TransitionRow = {
  action: string;
  at: Date;
  backfilled: boolean;
  condition: string;
  level: string;
  previous_level: string | null;
  reason: string;
};

// Recording order is independent of timestamps, which can be equal when the
// Hub's clock steps back. Occurrences keep their own order in the caller.
export const readConditionTransitions = async (
  sql: SQL,
  conditions: readonly { id: string }[],
): Promise<Map<string, ConditionTransition[]>> => {
  const grouped = new Map<string, ConditionTransition[]>();
  if (conditions.length === 0) {
    return grouped;
  }
  const rows: TransitionRow[] = await sql`
    SELECT condition, action, at, level, previous_level, reason, backfilled
    FROM condition_transitions
    WHERE condition IN ${sql(conditions.map(({ id }) => id))}
    ORDER BY id
  `;
  for (const row of rows) {
    const common = {
      at: row.at.getTime(),
      backfilled: row.backfilled,
      level: ConditionLevelSchema.parse(row.level),
      reason: row.reason,
    };
    let transition: ConditionTransition;
    if (row.action === 'raised' || row.action === 'cleared') {
      transition = { ...common, kind: row.action };
    } else if (row.action === 'level_changed') {
      transition = {
        ...common,
        kind: 'level_changed',
        previousLevel: ConditionLevelSchema.parse(row.previous_level),
      };
    } else {
      throw new Error(`The Hub holds an unknown Condition transition: ${row.action}.`);
    }
    const own = grouped.get(row.condition) ?? [];
    own.push(transition);
    grouped.set(row.condition, own);
  }
  return grouped;
};
