import type { SQL } from 'bun';

// How many stale Sessions one transaction refreshes. A batch holds its Sessions'
// stale rows until it commits, so a parse that marks one of them waits that
// long, and a batch is one statement under the statement timeout: a Session of
// thousands of requests takes about a second.
export const REFRESH_BATCH = 5;

// How long one refresh keeps taking batches, so a backlog, such as every
// Session after a parser switch, drains over several runs.
export const REFRESH_BUDGET_MS = 10_000;

// Stores the stretches and totals of stale Sessions, those with the latest
// requests first, a batch per transaction, until none is left or `budgetMs`
// has passed. The insight views read what this stored, so they show a change
// once it has run (ADR-0016). Returns how many Sessions it refreshed.
export const refreshSessionInsight = async (
  sql: SQL,
  { budgetMs = REFRESH_BUDGET_MS, now = Date.now }: { budgetMs?: number; now?: () => number } = {},
): Promise<number> => {
  const until = now() + budgetMs;
  let refreshed = 0;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one batch at a time, each its own transaction.
    const n = await refreshBatch(sql);
    refreshed += n;
    if (n < REFRESH_BATCH || now() >= until) {
      return refreshed;
    }
  }
};

const refreshBatch = async (sql: SQL): Promise<number> => {
  const [row]: { n: number }[] = await sql`SELECT refresh_session_insight(${REFRESH_BATCH}) AS n`;
  return row?.n ?? 0;
};
