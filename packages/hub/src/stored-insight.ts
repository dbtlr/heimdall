import type { SQL } from 'bun';

import { describeError } from './errors.ts';

// How long one refresh keeps picking Sessions, so a backlog, such as every
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
  const tried: SessionKey[] = [];
  const failed: string[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one Session per transaction, in turn.
    const key = await pickStaleSession(sql, tried);
    if (key === undefined) {
      break;
    }
    tried.push(key);
    try {
      // oxlint-disable-next-line no-await-in-loop -- one Session per transaction, in turn.
      refreshed += (await refreshSession(sql, key)) ? 1 : 0;
    } catch (error) {
      failed.push(`${key.harness} ${key.system} ${key.session_id}: ${describeError(error)}`);
      try {
        // oxlint-disable-next-line no-await-in-loop -- the failure counts before the next pick.
        await countFailure(sql, key);
      } catch (countError) {
        failed.push(`counting that failure: ${describeError(countError)}`);
      }
    }
    if (now() >= until) {
      break;
    }
  }
  if (failed.length > 0) {
    throw new Error(`Could not refresh ${failed.length} Session(s): ${failed.join('; ')}`);
  }
  return refreshed;
};

// The next stale Session to refresh, leaving out those this run tried.
const pickStaleSession = async (
  sql: SQL,
  tried: readonly SessionKey[],
): Promise<SessionKey | undefined> => {
  const [key]: SessionKey[] = await sql`
    SELECT * FROM pick_stale_session(${JSON.stringify(tried)}::text::jsonb)
  `;
  return key;
};

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
