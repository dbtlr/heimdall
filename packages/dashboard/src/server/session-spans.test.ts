import { beforeAll, expect, test } from 'bun:test';

import { NOW, startHub, timeline } from '@heimdall/hub/testing';
import type { SQL } from 'bun';

import { readPeriodSessions } from './agents-overview.ts';
import { readHomeAgents } from './home-agents.ts';
import { readJumpIndex } from './jump-index.ts';

beforeAll(async () => {
  await using _h = await startHub();
}, 60_000);

const DAY_MS = 86_400_000;

// How many stored stretches lie wholly before every window read here: a
// year-old archive, which no read of the last 30 days should touch.
const HISTORY = 500;

const { addSession } = timeline(NOW);

// The stretch entries `read` examines, through any index or a sequential scan
// of the stored stretches, counted by the statistics of its own transaction.
// The test's tables are small enough that the planner would rightly read
// every row of them, so sequential scans are discouraged, as their cost does
// on a live archive.
const stretchesExamined = (sql: SQL, read: (tx: SQL) => Promise<unknown>) =>
  sql.begin(async (tx) => {
    await tx`SET LOCAL enable_seqscan = off`;
    await read(tx);
    const [row]: { examined: number }[] = await tx`
      SELECT (sum(pg_stat_get_xact_tuples_returned(c.oid)))::int AS examined
      FROM pg_class c
      WHERE c.oid = 'stored_session_stretches'::regclass
         OR c.oid IN (SELECT indexrelid FROM pg_index
                      WHERE indrelid = 'stored_session_stretches'::regclass)
    `;
    return row?.examined;
  });

test.each([
  ["Home's agent figures", (tx: SQL) => readHomeAgents(tx, { now: NOW, timeZone: 'UTC' })],
  [
    "the Agents page's 30 days",
    (tx: SQL) => readPeriodSessions(tx, { from: new Date(NOW - 30 * DAY_MS), to: new Date(NOW) }),
  ],
  ['the jump index', (tx: SQL) => readJumpIndex(tx, { now: NOW })],
])('%s examine the stretches of the Sessions in the window, not the archive', async (_, read) => {
  await using h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('server-1')`;
  // Sessions of the last two days, none of them running, so Home reads the
  // newest request too.
  await addSession(h.db.sql, { id: 'yesterday', requests: [-DAY_MS / 1000, -DAY_MS / 2000] });
  await addSession(h.db.sql, { id: 'today', requests: [-7200, -3600] });
  // A year-old archive of one-stretch Sessions, stored as the refresh stores them.
  await h.db.sql`
    INSERT INTO stored_session_stretches (harness, system, source, session_id, started_at,
                                          ended_at, requests, link, candidates)
    SELECT 'claude-code', 'server-1', 'claude-code', 'old-' || n,
           ${new Date(NOW - 365 * DAY_MS)}::timestamptz + n * interval '1 hour',
           ${new Date(NOW - 365 * DAY_MS)}::timestamptz + n * interval '1 hour' + interval '10 minutes',
           1, 'unmatched', 0
    FROM generate_series(1, ${HISTORY}) n
  `;
  await h.db.sql`ANALYZE stored_session_stretches`;

  expect(await stretchesExamined(h.db.sql, read)).toBeLessThan(HISTORY / 10);
});
