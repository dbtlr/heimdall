import type { ConditionLimitSet } from '@heimdall/schema';
import type { SQL } from 'bun';

type LimitsRow = { limits: ConditionLimitSet; system: string };

// The limits the Hub judges each of `systems` by: its own, else the fleet's,
// stored under ''. Undefined for a System when the Hub has stored neither.
export const readConditionLimitsOf = async (
  sql: SQL,
  systems: readonly string[],
): Promise<(system: string) => ConditionLimitSet | undefined> => {
  const rows: LimitsRow[] = await sql`
    SELECT system, limits FROM condition_limits WHERE system IN ${sql(['', ...systems])}
  `;
  const limits = new Map(rows.map((row) => [row.system, row.limits]));
  return (system) => limits.get(system) ?? limits.get('');
};

// The limits the Hub judges a System by: its own, else the fleet's. Undefined
// when the Hub has stored none.
export const readConditionLimits = async (
  sql: SQL,
  system: string,
): Promise<ConditionLimitSet | undefined> => (await readConditionLimitsOf(sql, [system]))(system);
