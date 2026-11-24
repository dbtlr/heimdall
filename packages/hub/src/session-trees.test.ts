import { beforeAll, describe, expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { migratedDatabase, startTestServer } from './testing/postgres.ts';
import { timeline } from './testing/timeline.ts';

beforeAll(startTestServer, 60_000);

const T0 = Date.parse('2026-10-01T12:00:00Z');
const { addSession } = timeline(T0);

// Every request of a fixture Session on `priced-model` costs 5 (1 input at 1
// per token, 2 output at 2 per token); on any other model it is unpriced.
const PRICED = 'priced-model';

const database = async () => {
  const db = await migratedDatabase();
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now()), ('server-1', now())`;
  await db.sql`
    INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
    VALUES (${PRICED}, '2020-01-01', 'bundled', 1000000, 2000000, 100000)
  `;
  return db;
};

type Launched = {
  id: string;
  launchedBy?: string;
  harness?: string;
  system?: string;
  model?: string;
};

// Adds a Session with one request, launched by the Session id given.
const add = async (sql: SQL, { id, launchedBy, harness, system, model = PRICED }: Launched) => {
  await addSession(sql, {
    ...(harness === undefined ? {} : { harness }),
    id,
    model,
    requests: [1],
    ...(system === undefined ? {} : { system }),
  });
  if (launchedBy !== undefined) {
    await sql`UPDATE projected_sessions SET launching_session_id = ${launchedBy} WHERE session_id = ${id}`;
  }
};

const parent = async (sql: SQL, id: string) => {
  const [row]: {
    parent_session_id: string | null;
    parent_state: string;
    launching_session_id: string;
  }[] = await sql`
      SELECT launching_session_id, parent_session_id, parent_state
      FROM insight.session_parents WHERE session_id = ${id}
    `;
  return row;
};

// A Session's key on the fixture defaults: Claude Code on laptop-1.
const key = (id: string, harness = 'claude-code', system = 'laptop-1') =>
  [harness, system, harness, id] as const;

type Member = { depth: number; parent_session_id: string | null; session_id: string };

const tree = async (sql: SQL, root: string, harness?: string) => {
  const [h, system, source, id] = key(root, harness);
  const rows: Member[] = await sql`
    SELECT session_id, parent_session_id, depth
    FROM insight.session_tree(${h}, ${system}, ${source}, ${id})
  `;
  return rows;
};

const members = async (sql: SQL, root: string, harness?: string) =>
  (await tree(sql, root, harness)).map((row) => row.session_id).toSorted();

const total = async (sql: SQL, root: string) => {
  const [h, system, source, id] = key(root);
  const [row]: Record<string, string | null>[] = await sql`
    SELECT sessions, missing_sessions, requests, input_tokens, output_tokens, cache_read_tokens,
           cost_usd, priced_cost_usd, unpriced_requests
    FROM insight.session_tree_total(${h}, ${system}, ${source}, ${id})
  `;
  // Counts and dollar amounts arrive as strings; compare them as numbers.
  return row === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(row).map(([column, value]) => [
          column,
          value === null ? null : Number(value),
        ]),
      );
};

// Marks a Session as one a delete is deriving again.
const rederive = async (sql: SQL, id: string, harness = 'claude-code') => {
  await sql`
    INSERT INTO rederiving_sessions (harness, system, source, session_id)
    VALUES (${harness}, 'laptop-1', ${harness}, ${id})
  `;
};

describe('session parents', () => {
  test('a launching id names the one Session with that id, on another System', async () => {
    await using db = await database();
    await add(db.sql, { id: 'parent-1', system: 'server-1' });
    await add(db.sql, { harness: 'codex', id: 'child-1', launchedBy: 'parent-1' });
    expect(await parent(db.sql, 'child-1')).toMatchObject({
      launching_session_id: 'parent-1',
      parent_session_id: 'parent-1',
      parent_state: 'resolved',
    });
  });

  test('an id no Session has stays unresolved with the raw id', async () => {
    await using db = await database();
    await add(db.sql, { id: 'child-1', launchedBy: 'nobody' });
    expect(await parent(db.sql, 'child-1')).toMatchObject({
      launching_session_id: 'nobody',
      parent_session_id: null,
      parent_state: 'unmatched',
    });
  });

  test('an id two Sessions share stays unresolved', async () => {
    await using db = await database();
    await add(db.sql, { id: 'twin', system: 'server-1' });
    await add(db.sql, { id: 'twin', system: 'laptop-1' });
    await add(db.sql, { id: 'child-1', launchedBy: 'twin' });
    expect(await parent(db.sql, 'child-1')).toMatchObject({
      parent_session_id: null,
      parent_state: 'ambiguous',
    });
  });

  test('a Session that names itself stays unresolved', async () => {
    await using db = await database();
    await add(db.sql, { id: 'loop-1', launchedBy: 'loop-1' });
    expect(await parent(db.sql, 'loop-1')).toMatchObject({
      parent_session_id: null,
      parent_state: 'self',
    });
  });

  test('a parent that arrives later resolves with no reparse', async () => {
    await using db = await database();
    await add(db.sql, { id: 'child-1', launchedBy: 'late-parent' });
    expect((await parent(db.sql, 'child-1'))?.parent_state).toBe('unmatched');
    await add(db.sql, { id: 'late-parent' });
    expect(await parent(db.sql, 'child-1')).toMatchObject({
      parent_session_id: 'late-parent',
      parent_state: 'resolved',
    });
  });

  test("a Codex subagent's thread id resolves to that subagent's Session", async () => {
    await using db = await database();
    await addSession(db.sql, {
      harness: 'codex',
      id: 'codex-main',
      requests: [1],
      subagents: [{ agentId: 'thread-9', requests: [2] }],
    });
    await add(db.sql, { id: 'child-1', launchedBy: 'thread-9' });
    expect(await parent(db.sql, 'child-1')).toMatchObject({
      parent_session_id: 'codex-main',
      parent_state: 'resolved',
    });
  });

  test('a Codex subagent whose Session the Hub does not hold resolves nothing', async () => {
    await using db = await database();
    await addSession(db.sql, { harness: 'codex', id: 'codex-held', requests: [1] });
    await db.sql`
      INSERT INTO projected_subagents (harness, parser_version, system, source, session_id, agent_id)
      VALUES ('codex', 1, 'laptop-1', 'codex', 'codex-absent', 'thread-9')
    `;
    await add(db.sql, { id: 'child-1', launchedBy: 'thread-9' });
    expect(await parent(db.sql, 'child-1')).toMatchObject({
      parent_session_id: null,
      parent_state: 'unmatched',
    });
  });

  test("a Claude Code subagent's id never names a launcher", async () => {
    await using db = await database();
    await addSession(db.sql, {
      id: 'claude-main',
      requests: [1],
      subagents: [{ agentId: 'agent-7', requests: [2] }],
    });
    await add(db.sql, { id: 'child-1', launchedBy: 'agent-7' });
    expect((await parent(db.sql, 'child-1'))?.parent_state).toBe('unmatched');
  });

  test('a Session a delete is deriving again launches nothing', async () => {
    await using db = await database();
    await add(db.sql, { id: 'root-1' });
    await addSession(db.sql, {
      harness: 'codex',
      id: 'codex-main',
      requests: [1],
      subagents: [{ agentId: 'thread-9', requests: [2] }],
    });
    await add(db.sql, { id: 'child-1', launchedBy: 'root-1' });
    await add(db.sql, { id: 'child-2', launchedBy: 'thread-9' });
    await rederive(db.sql, 'root-1');
    await rederive(db.sql, 'codex-main', 'codex');
    expect((await parent(db.sql, 'child-1'))?.parent_state).toBe('unmatched');
    expect((await parent(db.sql, 'child-2'))?.parent_state).toBe('unmatched');
  });

  test('a Session a delete is deriving again has no row of its own', async () => {
    await using db = await database();
    await add(db.sql, { id: 'root-1' });
    await add(db.sql, { id: 'child-1', launchedBy: 'root-1' });
    await rederive(db.sql, 'child-1');
    expect(await parent(db.sql, 'child-1')).toBeUndefined();
  });

  test('a Session with no launching id has no row', async () => {
    await using db = await database();
    await add(db.sql, { id: 'solo' });
    expect(await parent(db.sql, 'solo')).toBeUndefined();
  });
});

describe('session trees', () => {
  test('a three-level tree lists its root first, each member under its parent', async () => {
    await using db = await database();
    await add(db.sql, { id: 'root-1' });
    await add(db.sql, { id: 'mid-1', launchedBy: 'root-1' });
    await add(db.sql, { id: 'leaf-1', launchedBy: 'mid-1' });
    expect(await tree(db.sql, 'root-1')).toEqual([
      { depth: 0, parent_session_id: null, session_id: 'root-1' },
      { depth: 1, parent_session_id: 'root-1', session_id: 'mid-1' },
      { depth: 2, parent_session_id: 'mid-1', session_id: 'leaf-1' },
    ]);
    expect(await members(db.sql, 'mid-1')).toEqual(['leaf-1', 'mid-1']);
    expect(await total(db.sql, 'root-1')).toMatchObject({
      cost_usd: 15,
      missing_sessions: 0,
      priced_cost_usd: 15,
      requests: 3,
      sessions: 3,
      unpriced_requests: 0,
    });
  });

  test("a tree's token sums are its members' sums", async () => {
    await using db = await database();
    await addSession(db.sql, {
      id: 'root-1',
      requests: [{ at: 1, cacheReadTokens: 5, inputTokens: 3, model: PRICED, outputTokens: 4 }],
    });
    await addSession(db.sql, {
      id: 'child-1',
      requests: [{ at: 2, cacheReadTokens: 30, inputTokens: 10, model: PRICED, outputTokens: 20 }],
    });
    await db.sql`UPDATE projected_sessions SET launching_session_id = 'root-1' WHERE session_id = 'child-1'`;
    expect(await total(db.sql, 'root-1')).toMatchObject({
      cache_read_tokens: 35,
      input_tokens: 13,
      output_tokens: 24,
    });
  });

  test("a Codex subagent's launches join its Session's tree", async () => {
    await using db = await database();
    await addSession(db.sql, {
      harness: 'codex',
      id: 'codex-main',
      requests: [1],
      subagents: [{ agentId: 'thread-9', requests: [2] }],
    });
    await add(db.sql, { id: 'child-1', launchedBy: 'thread-9' });
    expect(await members(db.sql, 'codex-main', 'codex')).toEqual(['child-1', 'codex-main']);
  });

  test('a launch that names two Sessions joins neither tree', async () => {
    await using db = await database();
    await add(db.sql, { id: 'twin', system: 'server-1' });
    await add(db.sql, { id: 'twin' });
    await add(db.sql, { id: 'child-1', launchedBy: 'twin' });
    expect(await members(db.sql, 'twin')).toEqual(['twin']);
  });

  test('a cycle ends, and each member roots a tree of the others', async () => {
    await using db = await database();
    await add(db.sql, { id: 'a-1', launchedBy: 'b-1' });
    await add(db.sql, { id: 'b-1', launchedBy: 'a-1' });
    expect(await members(db.sql, 'a-1')).toEqual(['a-1', 'b-1']);
    expect(await members(db.sql, 'b-1')).toEqual(['a-1', 'b-1']);
  });

  test('a Session a delete is deriving again is left out, with what it launched', async () => {
    await using db = await database();
    await add(db.sql, { id: 'root-1' });
    await add(db.sql, { id: 'mid-1', launchedBy: 'root-1' });
    await add(db.sql, { id: 'leaf-1', launchedBy: 'mid-1' });
    await rederive(db.sql, 'mid-1');
    expect(await members(db.sql, 'root-1')).toEqual(['root-1']);
    expect(await tree(db.sql, 'mid-1')).toEqual([]);
    expect(await total(db.sql, 'mid-1')).toBeUndefined();
  });

  test('an unpriced request leaves a lower bound and a count', async () => {
    await using db = await database();
    await add(db.sql, { id: 'root-1' });
    await add(db.sql, { id: 'child-1', launchedBy: 'root-1', model: 'unpriced-model' });
    const row = await total(db.sql, 'root-1');
    expect(row).toMatchObject({ cost_usd: null, priced_cost_usd: 5, unpriced_requests: 1 });
  });

  test('a member with no stored totals makes the tree incomplete', async () => {
    await using db = await database();
    await add(db.sql, { id: 'root-1' });
    await add(db.sql, { id: 'child-1', launchedBy: 'root-1' });
    await db.sql`DELETE FROM stored_session_totals WHERE session_id = 'child-1'`;
    expect(await total(db.sql, 'root-1')).toMatchObject({
      cost_usd: null,
      missing_sessions: 1,
      priced_cost_usd: 5,
      requests: 1,
      sessions: 2,
    });
  });

  test('a Session that launched nothing is a tree of itself', async () => {
    await using db = await database();
    await add(db.sql, { id: 'solo' });
    expect(await members(db.sql, 'solo')).toEqual(['solo']);
    expect(await total(db.sql, 'solo')).toMatchObject({ cost_usd: 5, requests: 1, sessions: 1 });
  });

  test('a Session the Hub does not hold has no tree', async () => {
    await using db = await database();
    expect(await tree(db.sql, 'nobody')).toEqual([]);
    expect(await total(db.sql, 'nobody')).toBeUndefined();
  });
});
