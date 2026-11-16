import type { SQL } from 'bun';

// Refreshes the planner's statistics for `tables` inside `tx`. A delete plans
// each join by how many rows its tables hold and how their values spread.
// Statistics that count almost none of the rows, as an ANALYZE during a bulk
// insert leaves them, let the planner pair every row of one table with every
// row of another: minutes for a few thousand generations, past the statement
// timeout for more (HMD-209). Turning a join method off only moves the pairing
// to another. An ANALYZE in the delete's own transaction samples what the
// tables hold now, the delete's own marks included. Its lock, held until the
// delete commits, holds back VACUUM, another ANALYZE, and schema changes to
// those tables, but no read or write of their rows. The ANALYZE itself waits
// for a VACUUM under way, which for an anti-wraparound autovacuum on a large
// table can take minutes.
export const refreshStatistics = async (tx: SQL, tables: readonly string[]): Promise<void> => {
  await tx.unsafe(`ANALYZE ${tables.join(', ')}`);
};
