import type { SQL } from 'bun';

// Refreshes the planner's statistics for `tables` inside `tx`. A delete plans
// each join by how many rows its tables hold and how their values spread.
// Statistics that count almost none of the rows, as an ANALYZE during a bulk
// insert leaves them, let the planner pair every row of one table with every
// row of another: minutes for a few thousand generations, past the statement
// timeout for more (HMD-209). Turning a join method off only moves the pairing
// to another. An ANALYZE in the delete's own transaction samples what the
// tables hold now, the delete's own marks included, and holds a lock only
// VACUUM and another ANALYZE wait for until the delete commits.
export const refreshStatistics = async (tx: SQL, tables: readonly string[]): Promise<void> => {
  await tx.unsafe(`ANALYZE ${tables.join(', ')}`);
};
