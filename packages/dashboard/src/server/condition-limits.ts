import type { ConditionLimitSet } from '@heimdall/schema';
import type { SQL } from 'bun';

// The limits the Hub judges a System by: its own, else the fleet's. Undefined
// when the Hub has stored none.
export const readConditionLimits = async (
  sql: SQL,
  system: string,
): Promise<ConditionLimitSet | undefined> => {
  const rows: { limits: ConditionLimitSet; system: string }[] = await sql`
    SELECT system, limits FROM condition_limits WHERE system IN (${system}, '')
  `;
  return (rows.find((row) => row.system === system) ?? rows[0])?.limits;
};
