import type { SQL } from 'bun';

const DAY_MS = 86_400_000;

// How long the Hub keeps each kind of Vitals row (ADR-0008): raw samples for
// 14 days, and the 5-minute rollups they feed for a year.
export const RAW_RETENTION_MS = 14 * DAY_MS;
export const ROLLUP_RETENTION_MS = 365 * DAY_MS;

export type Pruned = { diskRollups: number; samples: number; vitalsRollups: number };

// Deletes the Vitals older than their retention at `now` (epoch milliseconds):
// samples with `t`, and rollups with `bucket`, strictly before the cutoff. A row
// exactly at the cutoff stays until the next prune. Returns the rows deleted.
export const pruneVitals = (sql: SQL, now: number): Promise<Pruned> =>
  sql.begin(async (tx) => {
    const rawCutoff = new Date(now - RAW_RETENTION_MS);
    const rollupCutoff = new Date(now - ROLLUP_RETENTION_MS);
    const samples = await tx`DELETE FROM vitals_samples WHERE t < ${rawCutoff}`;
    const vitalsRollups = await tx`DELETE FROM vitals_rollups WHERE bucket < ${rollupCutoff}`;
    const diskRollups = await tx`DELETE FROM disk_rollups WHERE bucket < ${rollupCutoff}`;
    return {
      diskRollups: diskRollups.count,
      samples: samples.count,
      vitalsRollups: vitalsRollups.count,
    };
  });
