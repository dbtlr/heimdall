import type { SQL } from 'bun';

// The longest gap between two records of the Hub listening that still counts
// as listening throughout, such as a quick restart. A longer one is an outage
// of the Hub or its database.
export const LISTENING_GAP_MS = 2 * 60_000;

// Records that the Hub is listening at `now` (epoch milliseconds). After a gap
// longer than LISTENING_GAP_MS since any Hub sharing the database last recorded
// it, the Hub has been listening only since `now`. The latest record replaces
// the one before, so a clock that ran ahead cannot hide a later gap.
export const recordListening = async (sql: SQL, now: number): Promise<void> => {
  const at = new Date(now);
  await sql`
    UPDATE hub_listening SET
      listening_since = CASE
        WHEN heard_at IS NULL OR heard_at < ${new Date(now - LISTENING_GAP_MS)} THEN ${at}
        ELSE listening_since
      END,
      heard_at = ${at}
  `;
};

// When the Hub last began listening without an outage, as epoch milliseconds
// at `now`, or undefined when no Hub has recorded that it listens. A Hub that
// has not recorded it for longer than the gap is just back from an outage,
// even before its next record says so.
export const whenListening = async (sql: SQL, now: number): Promise<number | undefined> => {
  const [row]: { heard_at: Date | null; listening_since: Date | null }[] = await sql`
    SELECT heard_at, listening_since FROM hub_listening
  `;
  if (row?.heard_at == null || row.listening_since === null) {
    return undefined;
  }
  return now - row.heard_at.getTime() > LISTENING_GAP_MS ? now : row.listening_since.getTime();
};
