import type { SQL } from 'bun';

import { describeError } from './errors.ts';

// How many stale Sessions one pick returns, so the pick's scan of every stale
// Session is shared by several refreshes. Sessions a run picks but has no
// budget left for stay stale, unpenalized, for the next run.
export const REFRESH_PICK = 20;

// How long one refresh keeps refreshing Sessions, so a backlog, such as every
// Session after a parser switch, drains over several runs.
export const REFRESH_BUDGET_MS = 10_000;

type SessionKey = { harness: string; session_id: string; source: string; system: string };

// Stores the stretches and totals of stale Sessions one at a time, those that
// failed fewest times and then those with the latest requests first, until
// none is left or `budgetMs` has passed. Each Session is its own transaction
// under the statement timeout, so one that cannot be refreshed holds up no
// other and a run overshoots its budget by at most one timeout; a failed
// Session is tried again behind the rest, and left after 3 tries until it is
// marked again. The insight views read what this stored, so they show a
// change once it has run (ADR-0016). Returns how many Sessions it refreshed,
// and throws after the run, naming them, when any failed.
export const refreshSessionInsight = async (
  sql: SQL,
  { budgetMs = REFRESH_BUDGET_MS, now = Date.now }: { budgetMs?: number; now?: () => number } = {},
): Promise<number> => {
  const until = now() + budgetMs;
  let refreshed = 0;
  // Sessions this run leaves: those that failed, and those another refresh
  // holds. A Session refreshed is no longer stale, so no pick returns it.
  const skipped: SessionKey[] = [];
  const failed: string[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a pick waits for the refreshes before it.
    const picked = await pickStaleSessions(sql, skipped);
    if (picked.length === 0) {
      break;
    }
    for (const key of picked) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- one Session per transaction, in turn.
        if (await refreshSession(sql, key)) {
          refreshed += 1;
        } else {
          skipped.push(key);
        }
      } catch (error) {
        skipped.push(key);
        failed.push(`${key.harness} ${key.system} ${key.session_id}: ${describeError(error)}`);
        try {
          // oxlint-disable-next-line no-await-in-loop -- the failure counts before the next pick.
          await countFailure(sql, key);
        } catch (countError) {
          failed.push(`counting that failure: ${describeError(countError)}`);
        }
      }
      if (now() >= until) {
        return finish(refreshed, failed);
      }
    }
  }
  return finish(refreshed, failed);
};

const finish = (refreshed: number, failed: readonly string[]): number => {
  if (failed.length > 0) {
    throw new Error(`Could not refresh ${failed.length} Session(s): ${failed.join('; ')}`);
  }
  return refreshed;
};

// The next stale Sessions to refresh, leaving out those in `skipped`.
const pickStaleSessions = (sql: SQL, skipped: readonly SessionKey[]): Promise<SessionKey[]> => sql`
  SELECT * FROM pick_stale_sessions(${JSON.stringify(skipped)}::text::jsonb, ${REFRESH_PICK})
`;

const countFailure = (sql: SQL, key: SessionKey) => sql`
  UPDATE stale_sessions SET attempts = attempts + 1
  WHERE (harness, system, source, session_id)
      = (${key.harness}, ${key.system}, ${key.source}, ${key.session_id})
`;

const refreshSession = async (sql: SQL, key: SessionKey): Promise<boolean> => {
  const [row]: { refreshed: boolean }[] = await sql`
    SELECT refresh_stale_session(${key.harness}, ${key.system}, ${key.source}, ${key.session_id})
      AS refreshed
  `;
  return row?.refreshed === true;
};
