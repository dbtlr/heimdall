import { beforeAll, expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { MIGRATIONS, migrate } from './migrations.ts';
import { holdSpawningLinks } from './projection.ts';
import { refreshSessionInsight } from './stored-insight.ts';
import { migratedDatabase, plainRows, startTestServer, testDatabase } from './testing/postgres.ts';
import { timeline } from './testing/timeline.ts';
import { deleteTranscripts } from './transcripts.ts';

beforeAll(startTestServer, 60_000);

const { addSession } = timeline(Date.parse('2026-10-01T12:00:00Z'));

const setup = (sql: SQL) => sql`
  INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now());
  INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
  VALUES ('priced-model', '2020-01-01', 'bundled', 1000000, 2000000, 100000);
`;

type RoleTotal = {
  cost_usd: number | null;
  priced_cost_usd: number | null;
  requests: number;
  role_class: 'delegated' | 'main' | 'review';
  seat: string | null;
  unpriced_requests: number;
};

const roleTotals = (sql: SQL) =>
  plainRows<RoleTotal>(sql`
    SELECT role_class, seat, requests::int, cost_usd::float8, priced_cost_usd::float8,
           unpriced_requests::int
    FROM insight.session_role_totals WHERE session_id = 's1'
    ORDER BY role_class, seat
  `);

const subagentRoles = (sql: SQL) =>
  plainRows(sql`
    SELECT agent_id, effective_role, effective_seat, role_class
    FROM insight.subagents WHERE session_id = 's1' ORDER BY agent_id
  `);

const roleCounts = async (sql: SQL) =>
  (await roleTotals(sql)).map(({ role_class, seat, requests }) => ({ requests, role_class, seat }));

const staleTotals = (sql: SQL) =>
  plainRows(sql`SELECT session_id, stretches, totals FROM stale_sessions ORDER BY session_id`);

const s1Totals = [{ session_id: 's1', stretches: false, totals: true }];

test('an untagged main conversation counts as main and its untagged subagent counts as delegated', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    model: 'priced-model',
    requests: [10],
    subagentRequests: [20],
  });

  expect(
    await plainRows(
      db.sql`SELECT effective_role, effective_seat, role_class FROM insight.sessions`,
    ),
  ).toEqual([{ effective_role: null, effective_seat: null, role_class: 'main' }]);
  expect(await subagentRoles(db.sql)).toEqual([
    { agent_id: 'a1', effective_role: null, effective_seat: null, role_class: 'delegated' },
  ]);
  expect(await roleTotals(db.sql)).toEqual([
    {
      cost_usd: 5,
      priced_cost_usd: 5,
      requests: 1,
      role_class: 'delegated',
      seat: null,
      unpriced_requests: 0,
    },
    {
      cost_usd: 5,
      priced_cost_usd: 5,
      requests: 1,
      role_class: 'main',
      seat: null,
      unpriced_requests: 0,
    },
  ]);
});

test('a reviewer Session and its untagged subagent count under the Session’s review seat', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10], subagentRequests: [20] });
  await db.sql`
    UPDATE projected_sessions SET role = 'review', seat = 'architect', role_source = 'tag'
    WHERE session_id = 's1'
  `;

  expect(await subagentRoles(db.sql)).toEqual([
    { agent_id: 'a1', effective_role: 'review', effective_seat: 'architect', role_class: 'review' },
  ]);
  await refreshSessionInsight(db.sql);
  expect(await roleCounts(db.sql)).toEqual([
    { requests: 2, role_class: 'review', seat: 'architect' },
  ]);
});

test('a nested subagent inherits the nearest parent subagent’s role and seat', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    requests: [10],
    subagents: [
      { agentId: 'a1', requests: [20] },
      { agentId: 'a2', parentAgentId: 'a1', requests: [30] },
      { agentId: 'a3', parentAgentId: 'a2', requests: [40] },
    ],
  });
  await db.sql`
    UPDATE projected_sessions SET role = 'review', seat = 'architect', role_source = 'tag'
    WHERE session_id = 's1';
    UPDATE projected_subagents SET role = 'review', seat = 'breaker', role_source = 'tag'
    WHERE agent_id = 'a1';
  `.simple();

  expect(await subagentRoles(db.sql)).toEqual([
    { agent_id: 'a1', effective_role: 'review', effective_seat: 'breaker', role_class: 'review' },
    { agent_id: 'a2', effective_role: 'review', effective_seat: 'breaker', role_class: 'review' },
    { agent_id: 'a3', effective_role: 'review', effective_seat: 'breaker', role_class: 'review' },
  ]);
  await refreshSessionInsight(db.sql);
  expect(await roleCounts(db.sql)).toEqual([
    { requests: 1, role_class: 'review', seat: 'architect' },
    { requests: 3, role_class: 'review', seat: 'breaker' },
  ]);
});

test('a 300-deep chain of subagents inherits the role at its top, in the views and the split', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  const depth = 300;
  await addSession(db.sql, {
    id: 's1',
    requests: [10],
    subagents: Array.from({ length: depth }, (_, i) => ({
      agentId: `a${String(i + 1).padStart(3, '0')}`,
      ...(i === 0 ? {} : { parentAgentId: `a${String(i).padStart(3, '0')}` }),
      requests: [20 + i],
    })),
  });
  await db.sql`
    UPDATE projected_subagents SET role = 'review', seat = 'breaker', role_source = 'tag'
    WHERE agent_id = 'a001'
  `;

  expect(
    await plainRows(db.sql`
      SELECT effective_role, effective_seat, role_class, count(*)::int AS subagents
      FROM insight.subagents WHERE session_id = 's1'
      GROUP BY effective_role, effective_seat, role_class
    `),
  ).toEqual([
    { effective_role: 'review', effective_seat: 'breaker', role_class: 'review', subagents: depth },
  ]);
  await refreshSessionInsight(db.sql);
  expect(await roleCounts(db.sql)).toEqual([
    { requests: 1, role_class: 'main', seat: null },
    { requests: depth, role_class: 'review', seat: 'breaker' },
  ]);
});

test('a role above a role: each subagent takes the nearest one', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    requests: [10],
    subagents: [
      { agentId: 'a1', requests: [20] },
      { agentId: 'a2', parentAgentId: 'a1', requests: [30] },
      { agentId: 'a3', parentAgentId: 'a2', requests: [40] },
      { agentId: 'a4', parentAgentId: 'a3', requests: [50] },
    ],
  });
  await db.sql`
    UPDATE projected_subagents SET role = 'implementation', role_source = 'tag'
    WHERE agent_id = 'a1';
    UPDATE projected_subagents SET role = 'review', seat = 'verifier', role_source = 'tag'
    WHERE agent_id = 'a3';
  `.simple();

  expect(await subagentRoles(db.sql)).toEqual([
    {
      agent_id: 'a1',
      effective_role: 'implementation',
      effective_seat: null,
      role_class: 'delegated',
    },
    {
      agent_id: 'a2',
      effective_role: 'implementation',
      effective_seat: null,
      role_class: 'delegated',
    },
    { agent_id: 'a3', effective_role: 'review', effective_seat: 'verifier', role_class: 'review' },
    { agent_id: 'a4', effective_role: 'review', effective_seat: 'verifier', role_class: 'review' },
  ]);
});

test('a preamble-only review has an unknown seat even when its Session names a seat', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10], subagentRequests: [20] });
  await db.sql`
    UPDATE projected_sessions SET role = 'review', seat = 'unknown', role_source = 'tag'
    WHERE session_id = 's1';
    UPDATE projected_subagents SET role = 'review', role_source = 'preamble' WHERE agent_id = 'a1';
  `.simple();

  expect(await subagentRoles(db.sql)).toEqual([
    { agent_id: 'a1', effective_role: 'review', effective_seat: null, role_class: 'review' },
  ]);
  await refreshSessionInsight(db.sql);
  expect(await roleCounts(db.sql)).toEqual([
    { requests: 1, role_class: 'review', seat: 'unknown' },
    { requests: 1, role_class: 'review', seat: null },
  ]);
});

test('a parent-agent cycle falls back to the main conversation’s role', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    requests: [10],
    subagents: [
      { agentId: 'a1', parentAgentId: 'a2', requests: [20] },
      { agentId: 'a2', parentAgentId: 'a1', requests: [30] },
    ],
  });
  await db.sql`
    UPDATE projected_sessions SET role = 'review', seat = 'verifier', role_source = 'tag'
    WHERE session_id = 's1'
  `;

  expect(await subagentRoles(db.sql)).toEqual([
    { agent_id: 'a1', effective_role: 'review', effective_seat: 'verifier', role_class: 'review' },
    { agent_id: 'a2', effective_role: 'review', effective_seat: 'verifier', role_class: 'review' },
  ]);
  await refreshSessionInsight(db.sql);
  expect(await roleCounts(db.sql)).toEqual([
    { requests: 3, role_class: 'review', seat: 'verifier' },
  ]);
});

test('a missing parent subagent falls back to the main conversation’s role', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    requests: [10],
    subagents: [{ agentId: 'a1', parentAgentId: 'unheld', requests: [20] }],
  });
  await db.sql`
    UPDATE projected_sessions SET role = 'implementation', role_source = 'preamble'
    WHERE session_id = 's1'
  `;

  expect(await subagentRoles(db.sql)).toEqual([
    {
      agent_id: 'a1',
      effective_role: 'implementation',
      effective_seat: null,
      role_class: 'delegated',
    },
  ]);
  await refreshSessionInsight(db.sql);
  expect(await roleCounts(db.sql)).toEqual([{ requests: 2, role_class: 'delegated', seat: null }]);
});

test('role totals retain priced subtotals and counts when a request has no price', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    model: 'priced-model',
    requests: [10, { at: 20, model: 'unpriced-model' }],
    subagents: [{ agentId: 'a1', requests: [{ at: 30, model: 'unpriced-model' }] }],
  });

  expect(await roleTotals(db.sql)).toEqual([
    {
      cost_usd: null,
      priced_cost_usd: null,
      requests: 1,
      role_class: 'delegated',
      seat: null,
      unpriced_requests: 1,
    },
    {
      cost_usd: null,
      priced_cost_usd: 5,
      requests: 2,
      role_class: 'main',
      seat: null,
      unpriced_requests: 1,
    },
  ]);
});

test('inserting a subagent row marks its Session’s totals stale', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10] });

  await db.sql`
    INSERT INTO projected_subagents (harness, parser_version, system, source, session_id, agent_id)
    SELECT harness, parser_version, system, source, session_id, 'a1'
    FROM projected_sessions WHERE session_id = 's1'
  `;

  expect(await staleTotals(db.sql)).toEqual(s1Totals);
});

test('updating a subagent’s role marks its Session’s totals stale and refresh replaces its old split', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10], subagentRequests: [20] });

  await db.sql`
    UPDATE projected_subagents SET role = 'review', seat = 'breaker', role_source = 'tag'
    WHERE agent_id = 'a1'
  `;

  expect(await staleTotals(db.sql)).toEqual(s1Totals);
  expect(await roleCounts(db.sql)).toEqual([
    { requests: 1, role_class: 'delegated', seat: null },
    { requests: 1, role_class: 'main', seat: null },
  ]);
  expect(await refreshSessionInsight(db.sql)).toBe(1);
  expect(await roleCounts(db.sql)).toEqual([
    { requests: 1, role_class: 'main', seat: null },
    { requests: 1, role_class: 'review', seat: 'breaker' },
  ]);
});

test('deleting a subagent row marks its Session’s totals stale', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10], subagentRequests: [20] });

  await db.sql`DELETE FROM projected_subagents WHERE agent_id = 'a1'`;

  expect(await staleTotals(db.sql)).toEqual(s1Totals);
});

test('deleting an old parser version’s subagent row marks nothing', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10], subagentRequests: [20] });
  await db.sql`UPDATE current_parsers SET version = 2`;
  await refreshSessionInsight(db.sql);

  await db.sql`DELETE FROM projected_subagents WHERE agent_id = 'a1'`;

  expect(await staleTotals(db.sql)).toEqual([]);
});

test('a parser switch between the totals and the split stores no split for a Session without totals', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10] });
  // The totals read a parser version that holds no s1; the split, read after
  // the switch back, holds it.
  await db.sql`
    UPDATE current_parsers SET version = 2;
    CREATE FUNCTION switch_parser_back() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE current_parsers SET version = 1;
      RETURN NULL;
    END
    $$;
    CREATE TRIGGER switch_parser_back AFTER INSERT ON stored_session_totals
      FOR EACH STATEMENT EXECUTE FUNCTION switch_parser_back();
  `.simple();
  await db.sql`
    SELECT mark_sessions_stale(array_agg(harness), array_agg(system), array_agg(source),
                               array_agg(session_id), false, true)
    FROM projected_sessions WHERE session_id = 's1'
  `;

  await db.sql`
    SELECT refresh_stale_session(harness, system, source, session_id)
    FROM projected_sessions WHERE session_id = 's1'
  `;

  expect(await plainRows(db.sql`SELECT session_id FROM stored_session_role_totals`)).toEqual([]);
});

const sessionWithSpawn = async (sql: SQL, spawningCall: string) => {
  await setup(sql).simple();
  await addSession(sql, {
    id: 's1',
    requests: [10],
    subagents: [
      { agentId: 'a1', requests: [20] },
      { agentId: 'a2', requests: [30] },
    ],
    toolCalls: [{ agentId: 'a1', at: 20, name: 'Agent' }],
  });
  await sql`
    UPDATE projected_subagents SET role = 'review', seat = 'breaker', role_source = 'tag'
    WHERE agent_id = 'a1'
  `;
  await sql`UPDATE projected_subagents SET tool_use_id = ${spawningCall} WHERE agent_id = 'a2'`;
  await refreshSessionInsight(sql);
};

const parentOf = async (sql: SQL, agentId: string) => {
  const [row]: { parent_agent_id: string | null }[] = await sql`
    SELECT parent_agent_id FROM insight.subagents WHERE agent_id = ${agentId}
  `;
  return row?.parent_agent_id;
};

test('pointing a subagent at a held spawning tool call reads its caller as the parent', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');

  expect(await parentOf(db.sql, 'a2')).toBe('a1');
  expect(await subagentRoles(db.sql)).toEqual([
    { agent_id: 'a1', effective_role: 'review', effective_seat: 'breaker', role_class: 'review' },
    { agent_id: 'a2', effective_role: 'review', effective_seat: 'breaker', role_class: 'review' },
  ]);
});

test('a subagent written after its spawning tool call reads the caller as its parent', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 'unheld-call');

  await db.sql`
    INSERT INTO projected_subagents (
      harness, parser_version, system, source, session_id, agent_id, tool_use_id
    )
    SELECT harness, parser_version, system, source, session_id, 'a3', 's1-call-0'
    FROM projected_sessions WHERE session_id = 's1'
  `;

  expect(await parentOf(db.sql, 'a2')).toBeNull();
  expect(await parentOf(db.sql, 'a3')).toBe('a1');
  expect(await staleTotals(db.sql)).toEqual(s1Totals);
});

test('inserting a spawning tool call marks the nested subagent’s Session stale', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 'late-spawn');
  expect(await parentOf(db.sql, 'a2')).toBeNull();

  await db.sql`
    INSERT INTO projected_tool_calls (
      harness, parser_version, system, source, session_id, agent_id, call_id, at,
      kind, name, generation, byte_offset
    )
    SELECT harness, parser_version, system, source, session_id, agent_id, 'late-spawn', at,
           kind, name, generation, byte_offset
    FROM projected_tool_calls WHERE call_id = 's1-call-0'
  `;

  expect(await parentOf(db.sql, 'a2')).toBe('a1');
  expect(await staleTotals(db.sql)).toEqual(s1Totals);
  await refreshSessionInsight(db.sql);
  expect(await roleCounts(db.sql)).toEqual([
    { requests: 1, role_class: 'main', seat: null },
    { requests: 2, role_class: 'review', seat: 'breaker' },
  ]);
});

test('moving a spawning tool call to the main conversation marks the nested subagent’s Session stale', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');

  await db.sql`UPDATE projected_tool_calls SET agent_id = NULL WHERE call_id = 's1-call-0'`;

  expect(await parentOf(db.sql, 'a2')).toBeNull();
  expect(await staleTotals(db.sql)).toEqual(s1Totals);
  await refreshSessionInsight(db.sql);
  expect(await roleCounts(db.sql)).toEqual([
    { requests: 1, role_class: 'delegated', seat: null },
    { requests: 1, role_class: 'main', seat: null },
    { requests: 1, role_class: 'review', seat: 'breaker' },
  ]);
});

test('deleting a spawning tool call marks the nested subagent’s Session stale', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');

  await db.sql`DELETE FROM projected_tool_calls WHERE call_id = 's1-call-0'`;

  expect(await parentOf(db.sql, 'a2')).toBeNull();
  expect(await staleTotals(db.sql)).toEqual(s1Totals);
});

test('deleting an old parser version’s spawning tool call marks nothing', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');
  await db.sql`UPDATE current_parsers SET version = 2`;
  await refreshSessionInsight(db.sql);

  await db.sql`DELETE FROM projected_tool_calls WHERE call_id = 's1-call-0'`;

  expect(await staleTotals(db.sql)).toEqual([]);
});

test('changing a spawning tool call’s id clears the parent of the subagent it spawned and marks its Session stale', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');

  await db.sql`UPDATE projected_tool_calls SET call_id = 's1-call-moved' WHERE call_id = 's1-call-0'`;

  expect(await parentOf(db.sql, 'a2')).toBeNull();
  expect(await staleTotals(db.sql)).toEqual(s1Totals);
});

const insertSpawnedSubagent = (sql: SQL) => sql`
  INSERT INTO projected_subagents (
    harness, parser_version, system, source, session_id, agent_id, tool_use_id
  )
  SELECT harness, parser_version, system, source, session_id, 'a3', 'late-spawn'
  FROM projected_sessions WHERE session_id = 's1'
`;

const insertSpawningCall = (sql: SQL) => sql`
  INSERT INTO projected_tool_calls (
    harness, parser_version, system, source, session_id, agent_id, call_id, at,
    kind, name, generation, byte_offset
  )
  SELECT harness, parser_version, system, source, session_id, agent_id, 'late-spawn', at,
         kind, name, generation, byte_offset
  FROM projected_tool_calls WHERE call_id = 's1-call-0'
`;

const waitingOnLock = async (sql: SQL) => {
  const [row]: { waiting: boolean }[] = await sql`
    SELECT count(*) > 0 AS waiting FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
  `;
  return row?.waiting === true;
};

// Two writers in their own transactions: the second writes while the first
// has not committed, and must still read the first's row once it commits.
// The first commits once the second waits on it, or has written without
// waiting, which leaves the parent unread. `firstAgain`, when given, is the
// first writer's last write, made while the second waits.
const writeConcurrently = async (
  sql: SQL,
  first: (sql: SQL) => PromiseLike<unknown>,
  second: (sql: SQL) => PromiseLike<unknown>,
  firstAgain?: (sql: SQL) => PromiseLike<unknown>,
) => {
  const one = await sql.reserve();
  const two = await sql.reserve();
  try {
    await one.unsafe('BEGIN');
    await two.unsafe('BEGIN');
    await first(one);
    const state = { written: false };
    const writing = (async () => {
      try {
        await second(two);
      } finally {
        state.written = true;
      }
    })();
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- polls until the second writer waits or ends.
      if (state.written || (await waitingOnLock(sql))) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- polls until the second writer waits or ends.
      await Bun.sleep(10);
    }
    await firstAgain?.(one);
    await one.unsafe('COMMIT');
    await writing;
    await two.unsafe('COMMIT');
  } finally {
    await one.release();
    await two.release();
  }
};

test('a subagent and its spawning tool call written at once in that order read the caller as its parent', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');

  await writeConcurrently(db.sql, insertSpawnedSubagent, insertSpawningCall);

  expect(await parentOf(db.sql, 'a3')).toBe('a1');
});

test('a spawning tool call and its subagent written at once in that order read the caller as its parent', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');

  await writeConcurrently(db.sql, insertSpawningCall, insertSpawnedSubagent);

  expect(await parentOf(db.sql, 'a3')).toBe('a1');
});

test('two projection writers that change the same subagent and call in opposite orders both commit', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');

  // Each takes the spawning-links lock first, as every projection write does,
  // so the second waits before it locks a row. Left to the triggers' lock,
  // the second would lock the subagent and wait for the first, which then
  // waits on the subagent: a deadlock.
  await writeConcurrently(
    db.sql,
    async (sql) => {
      await holdSpawningLinks(sql);
      await sql`UPDATE projected_tool_calls SET at = at WHERE call_id = 's1-call-0'`;
    },
    async (sql) => {
      await holdSpawningLinks(sql);
      await sql`UPDATE projected_subagents SET tool_use_id = 's1-call-0' WHERE agent_id = 'a2'`;
      await sql`UPDATE projected_tool_calls SET at = at WHERE call_id = 's1-call-0'`;
    },
    (sql) => sql`UPDATE projected_subagents SET tool_use_id = 'unheld-call' WHERE agent_id = 'a2'`,
  );

  expect(await parentOf(db.sql, 'a2')).toBe('a1');
});

test('a transcript delete by date across 200 sources commits, and a statement over them holds one spawning-links lock', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await db.sql`
    INSERT INTO current_parsers (harness, version) VALUES ('claude-code', 1);
    INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
    SELECT n, 'laptop-1', 'source-' || n, 'projects/p/s.jsonl', '2026-01-01', '2026-01-01'
    FROM generate_series(1, 200) n;
    INSERT INTO parse_progress (harness, parser_version, generation, session_id, parsed_through, held_seen)
    SELECT 'claude-code', 1, id, 's1', 0, 0 FROM transcript_generations;
    INSERT INTO projected_sessions (harness, parser_version, system, source, session_id)
    SELECT 'claude-code', 1, system, source, 's1' FROM transcript_generations;
    INSERT INTO projected_tool_calls (
      harness, parser_version, system, source, session_id, agent_id, call_id, at, kind, name,
      generation, byte_offset
    )
    SELECT 'claude-code', 1, system, source, 's1', 'a1', 'spawn', '2026-01-01', 'tool', 'Agent', id, 0
    FROM transcript_generations;
    INSERT INTO projected_subagents (
      harness, parser_version, system, source, session_id, agent_id, tool_use_id
    )
    SELECT 'claude-code', 1, system, source, 's1', a, CASE WHEN a = 'a2' THEN 'spawn' END
    FROM transcript_generations, unnest(ARRAY['a1', 'a2']) a;
  `.simple();

  const conn = await db.sql.reserve();
  try {
    await conn.unsafe('BEGIN');
    await conn`DELETE FROM projected_tool_calls`;
    expect(
      await plainRows(conn`
        SELECT count(*)::int AS held FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid()
      `),
    ).toEqual([{ held: 1 }]);
    await conn.unsafe('ROLLBACK');
  } finally {
    await conn.release();
  }

  const removed = await deleteTranscripts(db.sql, {
    before: Date.parse('2026-06-01T00:00:00Z'),
    now: Date.parse('2026-10-01T00:00:00Z'),
  });

  expect(removed.generations).toBe(200);
  expect(
    await plainRows(db.sql`
      SELECT (SELECT count(*)::int FROM projected_tool_calls) AS calls,
             (SELECT count(*)::int FROM projected_subagents) AS subagents
    `),
  ).toEqual([{ calls: 0, subagents: 0 }]);
});

// The plan of a read, with the nodes it never ran marked.
const executedPlan = async (sql: SQL, query: string) => {
  const rows: { 'QUERY PLAN': string }[] = await sql.unsafe(
    `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${query}`,
  );
  return rows.map((row) => row['QUERY PLAN']).join('\n');
};

test('a subagent read that selects no effective column skips the role walk', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');

  const plan = await executedPlan(
    db.sql,
    `SELECT count(*), max(parent_agent_id) FROM insight.subagents WHERE session_id = 's1'`,
  );

  expect(plan).not.toMatch(/Recursive Union \(actual/);
  expect(await executedPlan(db.sql, `SELECT role_class FROM insight.subagents`)).toMatch(
    /Recursive Union \(actual/,
  );
});

test('resolving a Session launched by a Codex subagent’s thread skips the role walk', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    harness: 'codex',
    id: 'codex-main',
    requests: [1],
    subagents: [{ agentId: 'thread-9', requests: [2] }],
  });
  await addSession(db.sql, { id: 'child-1', requests: [3] });
  await db.sql`UPDATE projected_sessions SET launching_session_id = 'thread-9' WHERE session_id = 'child-1'`;

  const plan = await executedPlan(
    db.sql,
    `SELECT parent_session_id FROM insight.session_parents WHERE session_id = 'child-1'`,
  );

  expect(plan).toContain('projected_subagents');
  expect(plan).not.toMatch(/Recursive Union \(actual/);
});

test('migration fills the split for Sessions with stored totals', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter(({ version }) => version <= 50),
  );
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10], subagentRequests: [20] });
  await db.sql`
    UPDATE projected_sessions SET role = 'review', seat = 'architect', role_source = 'tag'
    WHERE session_id = 's1'
  `;
  await refreshSessionInsight(db.sql);

  await migrate(db.sql);

  expect(await roleCounts(db.sql)).toEqual([
    { requests: 2, role_class: 'review', seat: 'architect' },
  ]);
});

test('migration stores the spawning conversation of every held subagent', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter(({ version }) => version <= 51),
  );
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    requests: [10],
    subagents: [
      { agentId: 'a1', requests: [20] },
      { agentId: 'a2', requests: [30] },
    ],
    toolCalls: [{ agentId: 'a1', at: 20, name: 'Agent' }],
  });
  await db.sql`UPDATE projected_subagents SET tool_use_id = 's1-call-0' WHERE agent_id = 'a2'`;

  await migrate(db.sql);

  expect(
    await plainRows(
      db.sql`SELECT agent_id, spawning_agent_id FROM projected_subagents ORDER BY agent_id`,
    ),
  ).toEqual([
    { agent_id: 'a1', spawning_agent_id: null },
    { agent_id: 'a2', spawning_agent_id: 'a1' },
  ]);
});

test('migration skips Sessions with no stored totals', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter(({ version }) => version <= 51),
  );
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10], subagentRequests: [20] });
  await refreshSessionInsight(db.sql);
  await addSession(db.sql, { id: 's2', requests: [10] });
  // addSession catches the stored totals up; drop the new Session's to leave it never refreshed.
  await db.sql`DELETE FROM stored_session_totals WHERE session_id = 's2'`;

  await migrate(db.sql);

  expect(
    await plainRows(
      db.sql`SELECT DISTINCT session_id FROM stored_session_role_totals ORDER BY session_id`,
    ),
  ).toEqual([{ session_id: 's1' }]);
});

// A request of an agent no subagent row describes, beside one main request.
const roleCountsWithMissingSubagent = async (role: string | null, seat: string | null) => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10, { agentId: 'ghost', at: 20 }] });
  await db.sql`
    UPDATE projected_sessions SET role = ${role}, seat = ${seat}, role_source = 'tag'
    WHERE session_id = 's1'
  `;
  await refreshSessionInsight(db.sql);
  expect(await subagentRoles(db.sql)).toEqual([]);
  return await roleCounts(db.sql);
};

test('a request with no subagent row under an untagged main conversation counts as delegated', async () => {
  expect(await roleCountsWithMissingSubagent(null, null)).toEqual([
    { requests: 1, role_class: 'delegated', seat: null },
    { requests: 1, role_class: 'main', seat: null },
  ]);
});

test('a request with no subagent row under a review main conversation counts in its seat', async () => {
  expect(await roleCountsWithMissingSubagent('review', 'verifier')).toEqual([
    { requests: 2, role_class: 'review', seat: 'verifier' },
  ]);
});

test('a request with no subagent row under a review with no seat counts in the null seat', async () => {
  expect(await roleCountsWithMissingSubagent('review', null)).toEqual([
    { requests: 2, role_class: 'review', seat: null },
  ]);
});

test('starting re-derivation forgets the stored role split with the Session totals', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, { id: 's1', requests: [10], subagentRequests: [20] });

  await db.sql`
    INSERT INTO rederiving_sessions (harness, system, source, session_id)
    SELECT harness, system, source, session_id FROM insight.sessions WHERE session_id = 's1'
  `;

  expect(await roleCounts(db.sql)).toEqual([]);
  expect(await plainRows(db.sql`SELECT * FROM stored_session_role_totals`)).toEqual([]);
});

const spawningAgents = (sql: SQL) =>
  plainRows<{ agent_id: string; parser_version: number; spawning_agent_id: string | null }>(sql`
    SELECT parser_version, agent_id, spawning_agent_id
    FROM projected_subagents ORDER BY parser_version, agent_id
  `);

test('changing a spawning tool call’s conversation moves the subagent it spawned to the new caller', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 's1-call-0');
  await db.sql`
    INSERT INTO projected_subagents (harness, parser_version, system, source, session_id, agent_id)
    SELECT harness, parser_version, system, source, session_id, 'a3'
    FROM projected_sessions WHERE session_id = 's1'
  `;

  // The call stays held under the same id, so the old caller is replaced, not cleared.
  await db.sql`UPDATE projected_tool_calls SET agent_id = 'a3' WHERE call_id = 's1-call-0'`;

  expect(await parentOf(db.sql, 'a2')).toBe('a3');
});

test('a subagent’s own parent wins over the conversation whose call spawned it', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    requests: [10],
    subagents: [
      { agentId: 'a1', requests: [20] },
      { agentId: 'a2', requests: [30] },
      { agentId: 'a3', parentAgentId: 'a1', requests: [40] },
    ],
    toolCalls: [{ agentId: 'a2', at: 30, name: 'Agent' }],
  });
  await db.sql`
    UPDATE projected_subagents SET role = 'review', seat = 'breaker', role_source = 'tag'
    WHERE agent_id = 'a1';
    UPDATE projected_subagents SET role = 'implementation', role_source = 'tag'
    WHERE agent_id = 'a2';
    UPDATE projected_subagents SET tool_use_id = 's1-call-0' WHERE agent_id = 'a3';
  `.simple();

  expect(await spawningAgents(db.sql)).toContainEqual({
    agent_id: 'a3',
    parser_version: 1,
    spawning_agent_id: 'a2',
  });
  expect(await parentOf(db.sql, 'a3')).toBe('a1');
  expect(await subagentRoles(db.sql)).toEqual([
    { agent_id: 'a1', effective_role: 'review', effective_seat: 'breaker', role_class: 'review' },
    {
      agent_id: 'a2',
      effective_role: 'implementation',
      effective_seat: null,
      role_class: 'delegated',
    },
    { agent_id: 'a3', effective_role: 'review', effective_seat: 'breaker', role_class: 'review' },
  ]);
});

test('a seat stored on a non-review role is not inherited by the subagents below it', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    requests: [10],
    subagents: [
      { agentId: 'a1', requests: [20] },
      { agentId: 'a2', parentAgentId: 'a1', requests: [30] },
    ],
  });
  // The parser stores no seat on a non-review role; write one directly.
  await db.sql`
    UPDATE projected_subagents SET role = 'implementation', seat = 'stray', role_source = 'tag'
    WHERE agent_id = 'a1';
  `.simple();

  expect(await subagentRoles(db.sql)).toEqual([
    {
      agent_id: 'a1',
      effective_role: 'implementation',
      effective_seat: null,
      role_class: 'delegated',
    },
    {
      agent_id: 'a2',
      effective_role: 'implementation',
      effective_seat: null,
      role_class: 'delegated',
    },
  ]);
});

const copySessionToParser = (sql: SQL, version: number, extra = '') =>
  sql.unsafe(`
    INSERT INTO projected_sessions (
      harness, parser_version, system, source, session_id, path, started_at, ended_at, role, seat,
      role_source
    )
    SELECT harness, ${String(version)}, system, source, session_id, path, started_at, ended_at,
           'review', 'architect', 'tag'
    FROM projected_sessions WHERE session_id = 's1' ${extra}
  `);

test('a Session with rows at an old and the current parser version shows only the current version’s subagents', async () => {
  await using db = await migratedDatabase();
  await setup(db.sql).simple();
  await addSession(db.sql, {
    id: 's1',
    requests: [10],
    subagents: [{ agentId: 'old1', requests: [20] }],
  });
  await copySessionToParser(db.sql, 2);
  await db.sql`
    INSERT INTO projected_subagents (
      harness, parser_version, system, source, session_id, agent_id, parent_agent_id, role,
      role_source
    )
    SELECT harness, 2, system, source, session_id, 'new1', NULL, NULL, NULL
    FROM projected_sessions WHERE session_id = 's1' AND parser_version = 2;
    INSERT INTO projected_subagents (
      harness, parser_version, system, source, session_id, agent_id, parent_agent_id, role,
      role_source
    )
    SELECT harness, 2, system, source, session_id, 'new2', 'new1', 'implementation', 'tag'
    FROM projected_sessions WHERE session_id = 's1' AND parser_version = 2;
    INSERT INTO projected_subagents (
      harness, parser_version, system, source, session_id, agent_id, parent_agent_id
    )
    SELECT harness, 2, system, source, session_id, 'new3', 'new2'
    FROM projected_sessions WHERE session_id = 's1' AND parser_version = 2;
    UPDATE current_parsers SET version = 2;
  `.simple();

  expect(await subagentRoles(db.sql)).toEqual([
    {
      agent_id: 'new1',
      effective_role: 'review',
      effective_seat: 'architect',
      role_class: 'review',
    },
    {
      agent_id: 'new2',
      effective_role: 'implementation',
      effective_seat: null,
      role_class: 'delegated',
    },
    {
      agent_id: 'new3',
      effective_role: 'implementation',
      effective_seat: null,
      role_class: 'delegated',
    },
  ]);
});

test('a subagent takes the caller of the call at its own parser version, not another version’s', async () => {
  await using db = await migratedDatabase();
  await sessionWithSpawn(db.sql, 'unheld-call');
  // A rebuild writes the new version's calls before its subagents, so both
  // versions hold a call with the same id, made by different conversations.
  await db.sql`
    INSERT INTO projected_tool_calls (
      harness, parser_version, system, source, session_id, agent_id, call_id, at,
      kind, name, generation, byte_offset
    )
    SELECT harness, 2, system, source, session_id, 'rebuilt-caller', call_id, at,
           kind, name, generation, byte_offset
    FROM projected_tool_calls WHERE call_id = 's1-call-0'
  `;
  await db.sql`
    INSERT INTO projected_subagents (
      harness, parser_version, system, source, session_id, agent_id, tool_use_id
    )
    SELECT harness, v, system, source, session_id, 'spawned-' || v, 's1-call-0'
    FROM projected_sessions, (VALUES (2), (1)) AS versions (v) WHERE session_id = 's1'
  `;

  expect(
    (await spawningAgents(db.sql)).filter((row) => row.agent_id.startsWith('spawned-')),
  ).toEqual([
    { agent_id: 'spawned-1', parser_version: 1, spawning_agent_id: 'a1' },
    { agent_id: 'spawned-2', parser_version: 2, spawning_agent_id: 'rebuilt-caller' },
  ]);
});
