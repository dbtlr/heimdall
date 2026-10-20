import type { SQL } from 'bun';

import { DELIVERY_LOCK } from './delivery.ts';

export type Silence = { system: string; until: Date };

// Silences `system` until `now` plus `forMs`, replacing any silence it held
// (ADR-0020). Answers when the silence ends, or undefined when the System is
// not paired, which stores nothing. It waits out a delivery pass in progress,
// which read the silences before sending, so once this answers no pass can
// send for the System.
export const setSilence = (
  sql: SQL,
  { forMs, now, system }: { forMs: number; now: number; system: string },
): Promise<Date | undefined> =>
  sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${DELIVERY_LOCK}))`;
    const [row]: { until: Date }[] = await tx`
      INSERT INTO silences (system, until, created_at)
      SELECT p.system, ${new Date(now + forMs)}, ${new Date(now)}
      FROM paired_systems p WHERE p.system = ${system}
      ON CONFLICT (system) DO UPDATE SET until = excluded.until, created_at = excluded.created_at
      RETURNING until
    `;
    return row?.until;
  });

// Ends `system`'s silence, answering whether one was active at `now`. A silence
// that has ended holds nothing and is not cleared.
export const clearSilence = async (sql: SQL, system: string, now: number): Promise<boolean> => {
  const cleared: unknown[] = await sql`
    DELETE FROM silences WHERE system = ${system} AND until > ${new Date(now)} RETURNING system
  `;
  return cleared.length > 0;
};

// The silences holding delivery at `now`, by System.
export const activeSilences = (sql: SQL, now: number): Promise<Silence[]> => sql`
  SELECT system, until FROM silences WHERE until > ${new Date(now)} ORDER BY system
`;
