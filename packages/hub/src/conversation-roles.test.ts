import { beforeAll, expect, test } from 'bun:test';

import { migratedDatabase, plainRows, startTestServer } from './testing/postgres.ts';
import { timeline } from './testing/timeline.ts';

beforeAll(startTestServer, 60_000);

const { addSession } = timeline(Date.parse('2026-10-01T12:00:00Z'));

// The one definition of a conversation's class (ADR-0025): the readers of the
// split read it, so a reader that re-derived the rule would drift from it.
test('insight.conversation_roles classes the main, a held, and an unheld conversation', async () => {
  await using db = await migratedDatabase();
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`.simple();
  await addSession(db.sql, {
    id: 's1',
    requests: [10, { agentId: 'ghost', at: 20 }],
    subagents: [{ agentId: 'held', requests: [30] }],
  });
  await db.sql`
    UPDATE projected_sessions SET role = 'review', seat = 'verifier', role_source = 'tag'
    WHERE session_id = 's1'
  `;
  await db.sql`
    UPDATE projected_subagents SET role = 'implementation', role_source = 'tag'
    WHERE agent_id = 'held'
  `;

  expect(
    await plainRows(db.sql`
      SELECT agent_id, role_class, seat FROM insight.conversation_roles
      WHERE session_id = 's1' ORDER BY agent_id NULLS FIRST
    `),
  ).toEqual([
    { agent_id: null, role_class: 'review', seat: 'verifier' },
    { agent_id: 'ghost', role_class: 'review', seat: 'verifier' },
    { agent_id: 'held', role_class: 'delegated', seat: null },
  ]);
});
