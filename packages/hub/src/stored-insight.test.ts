import { beforeAll, describe, expect, test } from 'bun:test';

import { SQL } from 'bun';

import { MIGRATIONS, migrate } from './migrations.ts';
import { syncPrices } from './price-table.ts';
import type { PriceEntry } from './prices.ts';
import { pruneVitals, RAW_RETENTION_MS } from './retention.ts';
import { refreshSessionInsight } from './stored-insight.ts';
import { startTestServer, testDatabase } from './testing/postgres.ts';
import { CWD, timeline } from './testing/timeline.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

// Times are seconds after T0, so a fixture reads as a timeline. The fixture
// helpers leave every Session refreshed; the changes below are written
// directly, as ingest and the parser write them, so they wait for a refresh.
const T0 = Date.parse('2026-10-01T12:00:00Z');
const { addProcess, addSession, at } = timeline(T0);

type Db = { sql: SQL; url: URL } & AsyncDisposable;

const database = async (): Promise<Db> => {
  const db = await testDatabase();
  await migrate(db.sql);
  await db.sql`
    INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now()), ('server-1', now())
  `;
  return db;
};

const price = (sql: SQL, input = 1_000_000) => sql`
  INSERT INTO model_prices (model, valid_from, source, input_per_mtok, output_per_mtok, context_window)
  VALUES ('priced-model', '2020-01-01', 'bundled', ${input}, 2000000, 100000)
  ON CONFLICT (model, valid_from, source, min_prompt_tokens) DO UPDATE SET input_per_mtok = ${input}
`;

// The rows each view shows and its computed_ view does not, or the other way
// round: none when the view reads exactly what is computed.
const differences = async (sql: SQL) => [
  ...(await sql`
    (SELECT 'stretch' AS kind, * FROM insight.session_stretches
     EXCEPT ALL SELECT 'stretch', * FROM computed_session_stretches)
    UNION ALL
    (SELECT 'stretch', * FROM computed_session_stretches
     EXCEPT ALL SELECT 'stretch', * FROM insight.session_stretches)
  `),
  ...(await sql`
    (SELECT 'totals' AS kind, * FROM insight.session_totals
     EXCEPT ALL SELECT 'totals', * FROM computed_session_totals)
    UNION ALL
    (SELECT 'totals', * FROM computed_session_totals
     EXCEPT ALL SELECT 'totals', * FROM insight.session_totals)
  `),
  ...(await sql`
    (SELECT 'model totals' AS kind, * FROM insight.session_model_totals
     EXCEPT ALL SELECT 'model totals', * FROM computed_session_model_totals)
    UNION ALL
    (SELECT 'model totals', * FROM computed_session_model_totals
     EXCEPT ALL SELECT 'model totals', * FROM insight.session_model_totals)
  `),
];

// The Sessions marked stale, once the ranges marked are read as the next
// refresh reads them.
const stale = async (sql: SQL): Promise<string[]> => {
  await sql`SELECT expand_stale_ranges()`;
  return (
    await sql`
      SELECT session_id, stretches, totals FROM stale_sessions ORDER BY session_id
    `
  ).map(
    (row: { session_id: string; stretches: boolean; totals: boolean }) =>
      `${row.session_id}${row.stretches ? ' stretches' : ''}${row.totals ? ' totals' : ''}`,
  );
};

// What the rules give for every Session: its stretches and its totals.
const computed = async (sql: SQL) => [
  await sql`SELECT * FROM computed_session_stretches ORDER BY session_id, started_at`,
  await sql`SELECT * FROM computed_session_totals ORDER BY session_id`,
];

const addRequest = (sql: SQL, session: string, requestId: string, seconds: number) => sql`
  INSERT INTO projected_requests (
    harness, parser_version, system, source, session_id, agent_id, request_id, at, model,
    input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, generation, byte_offset
  )
  SELECT harness, parser_version, system, source, ${session}, NULL, ${requestId}, ${at(seconds)},
         model, 1, 1, 0, 0, generation, 0
  FROM projected_requests WHERE request_id = 's1-0'
`;

// A process that ran Session s1, and a second Session no process ran.
const linkedSession = async (sql: SQL) => {
  await price(sql);
  const process = await addProcess(sql, { end: 600, pid: 100, start: 0 });
  await addSession(sql, { id: 's1', model: 'priced-model', requests: [10, 200, 590] });
  await addSession(sql, { id: 's2', requests: [5000, 5100] });
  return process;
};

describe('refreshing', () => {
  test('the views read a Session as it was at the last refresh, and as computed after the next', async () => {
    await using db = await database();
    await linkedSession(db.sql);
    const before = await db.sql`SELECT * FROM insight.session_stretches ORDER BY session_id`;

    await addRequest(db.sql, 's1', 's1-late', 700);

    expect(await db.sql`SELECT * FROM insight.session_stretches ORDER BY session_id`).toEqual(
      before,
    );
    expect(await stale(db.sql)).toEqual(['s1 stretches totals']);
    expect(await refreshSessionInsight(db.sql)).toBe(1);
    expect(await stale(db.sql)).toEqual([]);
    expect(await differences(db.sql)).toEqual([]);
  });

  test('refreshes until no Session is stale', async () => {
    await using db = await database();
    for (let i = 0; i < 6; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- fixtures in order.
      await addSession(db.sql, { id: `s${String(i).padStart(2, '0')}`, requests: [i * 10] });
    }
    await price(db.sql);

    expect(await refreshSessionInsight(db.sql)).toBe(6);
    expect(await stale(db.sql)).toEqual([]);
  });

  test('stops once its budget has passed', async () => {
    await using db = await database();
    for (let i = 0; i < 6; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- fixtures in order.
      await addSession(db.sql, { id: `s${String(i).padStart(2, '0')}`, requests: [i * 10] });
    }
    await price(db.sql);
    let clock = 0;

    const refreshed = await refreshSessionInsight(db.sql, {
      budgetMs: 1,
      now: () => (clock += 1),
    });

    expect(refreshed).toBe(1);
    expect(await stale(db.sql)).toHaveLength(5);
  });

  test('forgets a Session that is gone', async () => {
    await using db = await database();
    await linkedSession(db.sql);

    await db.sql`DELETE FROM projected_requests WHERE session_id = 's2'`;
    await db.sql`DELETE FROM projected_sessions WHERE session_id = 's2'`;
    await refreshSessionInsight(db.sql);

    const ids = await db.sql`
      SELECT session_id FROM insight.session_stretches
      UNION ALL SELECT session_id FROM insight.session_totals
    `;
    expect(ids.map(({ session_id }: { session_id: string }) => session_id)).toEqual(['s1', 's1']);
  });

  test('hides a Session a delete is deriving again at once', async () => {
    await using db = await database();
    await linkedSession(db.sql);

    await db.sql`
      INSERT INTO rederiving_sessions (harness, system, source, session_id)
      VALUES ('claude-code', 'laptop-1', 'claude-code', 's1')
    `;

    const ids = await db.sql`
      SELECT session_id FROM insight.session_stretches
      UNION ALL SELECT session_id FROM insight.session_totals
    `;
    expect(ids.map(({ session_id }: { session_id: string }) => session_id)).toEqual(['s2', 's2']);
  });
});

// Each change alters what the rules give for s1, marks s1 stale for what it
// altered, and is in the views once refreshed.
// A Session's stored model totals as "model: requests, priced cost, unpriced".
const modelTotals = async (sql: SQL, session: string): Promise<string[]> =>
  (
    await sql`
      SELECT model, requests, priced_cost_usd, unpriced_requests
      FROM insight.session_model_totals WHERE session_id = ${session} ORDER BY model
    `
  ).map(
    (row: {
      model: string;
      priced_cost_usd: string | null;
      requests: string;
      unpriced_requests: string;
    }) =>
      `${row.model}: ${row.requests}, ${row.priced_cost_usd === null ? 'null' : Number(row.priced_cost_usd)}, ${row.unpriced_requests}`,
  );

describe('model totals', () => {
  test('the refresh fills them per model, and replaces them when requests change', async () => {
    await using db = await database();
    await price(db.sql);
    await addSession(db.sql, {
      id: 's1',
      inputTokens: 1_000_000,
      model: 'priced-model',
      outputTokens: 0,
      requests: [10, { at: 20, model: 'unpriced-model' }, 30],
    });
    expect(await modelTotals(db.sql, 's1')).toEqual([
      'priced-model: 2, 2000000, 0',
      'unpriced-model: 1, null, 1',
    ]);

    await addRequest(db.sql, 's1', 's1-late', 40);
    expect(await modelTotals(db.sql, 's1')).toEqual([
      'priced-model: 2, 2000000, 0',
      'unpriced-model: 1, null, 1',
    ]);
    await refreshSessionInsight(db.sql);

    expect(await modelTotals(db.sql, 's1')).toEqual([
      'priced-model: 3, 2000003, 0',
      'unpriced-model: 1, null, 1',
    ]);
    expect(await differences(db.sql)).toEqual([]);
  });

  test('a price change reprices them with the Session totals', async () => {
    await using db = await database();
    await price(db.sql);
    await addSession(db.sql, {
      id: 's1',
      inputTokens: 1_000_000,
      model: 'priced-model',
      outputTokens: 0,
      requests: [10, 20],
    });
    await price(db.sql, 3_000_000);

    expect(await modelTotals(db.sql, 's1')).toEqual(['priced-model: 2, 2000000, 0']);
    expect(await stale(db.sql)).toEqual(['s1 totals']);
    await refreshSessionInsight(db.sql);

    expect(await modelTotals(db.sql, 's1')).toEqual(['priced-model: 2, 6000000, 0']);
    expect(await differences(db.sql)).toEqual([]);
  });

  test('a Session a delete is deriving again loses them, and a Session that is gone keeps none', async () => {
    await using db = await database();
    await linkedSession(db.sql);
    await db.sql`
      INSERT INTO rederiving_sessions (harness, system, source, session_id)
      VALUES ('claude-code', 'laptop-1', 'claude-code', 's1')
    `;
    const [{ stored }] = await db.sql`
      SELECT count(*)::int AS stored FROM stored_session_model_totals WHERE session_id = 's1'
    `;
    expect(stored).toBe(0);

    await db.sql`DELETE FROM rederiving_sessions`;
    await db.sql`DELETE FROM projected_requests WHERE session_id = 's2'`;
    await db.sql`DELETE FROM projected_sessions WHERE session_id = 's2'`;
    await refreshSessionInsight(db.sql);

    expect(await modelTotals(db.sql, 's2')).toEqual([]);
    expect(await modelTotals(db.sql, 's1')).toHaveLength(1);
    expect(await differences(db.sql)).toEqual([]);
  });
});

describe('a change that alters a stored Session marks it stale', () => {
  const changes: [string, string, (sql: SQL, process: number) => Promise<unknown>][] = [
    ['a new request', 's1 stretches totals', (sql) => addRequest(sql, 's1', 's1-late', 700)],
    [
      'a new request within its span',
      's1 stretches totals',
      (sql) => addRequest(sql, 's1', 's1-mid', 300),
    ],
    [
      'a request moved to another Session',
      's1 stretches totals',
      (sql) => sql`UPDATE projected_requests SET session_id = 's2' WHERE request_id = 's1-2'`,
    ],
    [
      'its working directory',
      's1 stretches totals',
      (sql) => sql`
        UPDATE projected_sessions SET first_cwd = '/elsewhere', last_cwd = '/elsewhere'
        WHERE session_id = 's1'
      `,
    ],
    [
      'its process ending earlier',
      's1 stretches',
      (sql, process) => sql`
        UPDATE harness_processes SET ended_at = ${at(300)} WHERE id = ${process}
      `,
    ],
    [
      'a second process starting beside it',
      's1 stretches',
      (sql) => sql`
        INSERT INTO harness_processes (
          system, harness, pid, started_at, ended_at, end_missed, cwd, peak_rss_bytes,
          last_seen_at, sent_at
        )
        SELECT system, harness, 200, ${at(100)}, ended_at, false, cwd, 0, last_seen_at, sent_at
        FROM harness_processes WHERE pid = 100
      `,
    ],
    [
      'its readings pruned',
      's1 stretches',
      (sql, process) => sql`DELETE FROM harness_process_samples WHERE process = ${process}`,
    ],
    [
      'its process gone',
      's1 stretches',
      (sql, process) => sql`
        WITH gone AS (DELETE FROM harness_process_samples WHERE process = ${process})
        DELETE FROM harness_processes WHERE id = ${process}
      `,
    ],
    [
      'its requests gone',
      's1 stretches totals',
      (sql) => sql`DELETE FROM projected_requests WHERE session_id = 's1'`,
    ],
    [
      'its Session row gone',
      's1 stretches totals',
      (sql) => sql`DELETE FROM projected_sessions WHERE session_id = 's1'`,
    ],
    ['a price change', 's1 totals', (sql) => price(sql, 3_000_000)],
    [
      'a parser switch',
      's1 stretches totals',
      (sql) => sql`UPDATE current_parsers SET version = 2 WHERE harness = 'claude-code'`,
    ],
  ];

  for (const [name, marked, change] of changes) {
    test(name, async () => {
      await using db = await database();
      const process = await linkedSession(db.sql);
      const before = await computed(db.sql);

      await change(db.sql, process);

      expect(await computed(db.sql)).not.toEqual(before);
      expect(await stale(db.sql)).toContain(marked);
      await refreshSessionInsight(db.sql);
      expect(await differences(db.sql)).toEqual([]);
    });
  }

  test('a Vitals bucket that bounds a missed end', async () => {
    await using db = await database();
    await addProcess(db.sql, { end: 100, endMissed: true, pid: 100, start: 0 });
    await addSession(db.sql, { id: 's1', requests: [10, 50, 2000] });
    const before = await computed(db.sql);

    await db.sql`
      INSERT INTO vitals_rollups (
        system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max, memory_used_min,
        memory_used_sum, memory_used_max, memory_total_max, load_1_min, load_1_sum, load_1_max,
        uptime_min, collector_cpu_sum, collector_cpu_max, collector_rss_sum, collector_rss_max
      )
      VALUES ('laptop-1', ${at(300)}, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0)
    `;

    expect(await computed(db.sql)).not.toEqual(before);
    expect(await stale(db.sql)).toEqual(['s1 stretches']);
    await refreshSessionInsight(db.sql);
    expect(await differences(db.sql)).toEqual([]);
  });

  test('readings the prune removes', async () => {
    await using db = await database();
    await addProcess(db.sql, { end: 600, pid: 100, start: 0 });
    await addSession(db.sql, { id: 's1', requests: [10, 200, 590] });
    const before = await computed(db.sql);

    await pruneVitals(db.sql, T0 + RAW_RETENTION_MS + 3600_000);

    expect(await computed(db.sql)).not.toEqual(before);
    expect(await stale(db.sql)).toEqual(['s1 stretches']);
    await refreshSessionInsight(db.sql);
    expect(await differences(db.sql)).toEqual([]);
  });
});

describe('a change marks only the Sessions it can alter', () => {
  test('a process sighted again marks the Sessions since its last sighting, not those long before', async () => {
    await using db = await database();
    const process = await addProcess(db.sql, { pid: 100, seenTo: 50_000, start: 0 });
    await addSession(db.sql, { id: 'early', requests: [10, 20] });
    await addSession(db.sql, { id: 'recent', requests: [49_900, 50_000] });
    await addSession(db.sql, { id: 'elsewhere', requests: [49_900, 50_000], system: 'server-1' });

    await db.sql`UPDATE harness_processes SET last_seen_at = ${at(50_060)} WHERE id = ${process}`;

    expect(await stale(db.sql)).toEqual(['recent stretches']);
  });

  test('a price change leaves the stretches stored', async () => {
    await using db = await database();
    await linkedSession(db.sql);

    await price(db.sql, 3_000_000);

    expect(await stale(db.sql)).toEqual(['s1 totals', 's2 totals']);
  });

  test('a new reading marks the Sessions whose requests span it', async () => {
    await using db = await database();
    const process = await addProcess(db.sql, { end: 9000, pid: 100, start: 0 });
    await addSession(db.sql, { id: 'spans', requests: [100, 3000] });
    await addSession(db.sql, { id: 'before', requests: [10, 20] });
    await addSession(db.sql, { id: 'after', requests: [8000, 8500] });

    await db.sql`
      INSERT INTO harness_process_samples (process, t, cpu_micros, rss_bytes)
      VALUES (${process}, ${at(1500.5)}, 0, 0)
    `;

    expect(await stale(db.sql)).toEqual(['spans stretches']);
  });
});

describe('more changes that alter a stored Session', () => {
  test('readings kept only as rollups, pruned', async () => {
    await using db = await database();
    const process = await addProcess(db.sql, { end: 900, pid: 100, readings: 'rollups', start: 0 });
    await addSession(db.sql, { id: 's1', requests: [10, 450, 890] });
    const before = await computed(db.sql);

    await db.sql`DELETE FROM harness_process_rollups WHERE process = ${process}`;

    expect(await computed(db.sql)).not.toEqual(before);
    expect(await stale(db.sql)).toEqual(['s1 stretches']);
    await refreshSessionInsight(db.sql);
    expect(await differences(db.sql)).toEqual([]);
  });

  test('a rollup of readings stored late', async () => {
    await using db = await database();
    const process = await addProcess(db.sql, {
      end: 900,
      pid: 100,
      readings: 'rollups',
      seenFrom: 800,
      seenTo: 900,
      start: 0,
    });
    await addSession(db.sql, { id: 's1', requests: [10, 450, 890] });
    const before = await computed(db.sql);

    await db.sql`
      INSERT INTO harness_process_rollups
        (process, bucket, samples, cpu_micros_min, cpu_micros_max, rss_min, rss_sum, rss_max)
      VALUES (${process}, date_bin('5 minutes', ${at(300)}::timestamptz, timestamptz '2000-01-01 00:00:00+00'),
              1, 0, 0, 0, 0, 0)
    `;

    expect(await computed(db.sql)).not.toEqual(before);
    expect(await stale(db.sql)).toEqual(['s1 stretches']);
    await refreshSessionInsight(db.sql);
    expect(await differences(db.sql)).toEqual([]);
  });

  test('a Vitals bucket pruned that bounded a missed end', async () => {
    await using db = await database();
    await addProcess(db.sql, { end: 100, endMissed: true, pid: 100, start: 0 });
    await addSession(db.sql, { id: 's1', requests: [10, 50, 2000] });
    await addSession(db.sql, { id: 'later', requests: [9000, 9100] });
    await db.sql`
      INSERT INTO vitals_rollups (
        system, bucket, samples, cpu_busy_min, cpu_busy_sum, cpu_busy_max, memory_used_min,
        memory_used_sum, memory_used_max, memory_total_max, load_1_min, load_1_sum, load_1_max,
        uptime_min, collector_cpu_sum, collector_cpu_max, collector_rss_sum, collector_rss_max
      )
      SELECT 'laptop-1', ${at(0)}::timestamptz + s * interval '1 second', 1, 1, 1, 1, 1, 1, 1, 1,
             1, 1, 1, 1, 0, 0, 0, 0
      FROM unnest(ARRAY[300, 6000]) AS s
    `;
    await refreshSessionInsight(db.sql);
    const before = await computed(db.sql);

    await db.sql`DELETE FROM vitals_rollups WHERE bucket = ${at(300)}`;

    expect(await computed(db.sql)).not.toEqual(before);
    expect(await stale(db.sql)).toEqual(['s1 stretches']);
    await refreshSessionInsight(db.sql);
    expect(await differences(db.sql)).toEqual([]);
  });

  test('a Session a delete is deriving again loses its stored rows, and is marked once shown', async () => {
    await using db = await database();
    await linkedSession(db.sql);

    await db.sql`
      INSERT INTO rederiving_sessions (harness, system, source, session_id)
      VALUES ('claude-code', 'laptop-1', 'claude-code', 's1')
    `;
    const stored = await db.sql`
      SELECT session_id FROM stored_session_stretches
      UNION ALL SELECT session_id FROM stored_session_totals
    `;
    expect(stored.map(({ session_id }: { session_id: string }) => session_id)).toEqual([
      's2',
      's2',
    ]);

    await db.sql`DELETE FROM rederiving_sessions`;

    expect(await stale(db.sql)).toEqual(['s1 stretches totals']);
    await refreshSessionInsight(db.sql);
    expect(await differences(db.sql)).toEqual([]);
  });
});

describe('rows stored before what makes them count', () => {
  test("a Session's row stored after its requests", async () => {
    await using db = await database();
    await linkedSession(db.sql);
    const [row] = await db.sql`SELECT * FROM projected_sessions WHERE session_id = 's1'`;
    await db.sql`DELETE FROM projected_sessions WHERE session_id = 's1'`;
    await refreshSessionInsight(db.sql);
    const before = await computed(db.sql);

    await db.sql`INSERT INTO projected_sessions ${db.sql(row)}`;

    expect(await computed(db.sql)).not.toEqual(before);
    expect(await stale(db.sql)).toEqual(['s1 stretches totals']);
    await refreshSessionInsight(db.sql);
    expect(await differences(db.sql)).toEqual([]);
  });

  test("a Harness's first parser version", async () => {
    await using db = await database();
    await linkedSession(db.sql);
    await db.sql`DELETE FROM current_parsers`;
    await refreshSessionInsight(db.sql);
    const before = await computed(db.sql);

    await db.sql`INSERT INTO current_parsers (harness, version) VALUES ('claude-code', 1)`;

    expect(await computed(db.sql)).not.toEqual(before);
    expect(await stale(db.sql)).toEqual(['s1 stretches totals', 's2 stretches totals']);
    await refreshSessionInsight(db.sql);
    expect(await differences(db.sql)).toEqual([]);
  });
});

describe('the price table', () => {
  const entry: PriceEntry = {
    contextWindow: 100_000,
    input: 1,
    model: 'priced-model',
    output: 2,
    validFrom: '2020-01-01',
  };

  test('loaded again unchanged marks no Session', async () => {
    await using db = await database();
    await syncPrices(db.sql, { bundled: [entry], configured: [] });
    await addSession(db.sql, { id: 's1', model: 'priced-model', requests: [10] });

    await syncPrices(db.sql, { bundled: [entry], configured: [] });

    expect(await stale(db.sql)).toEqual([]);
  });

  test("loaded with a changed price marks every Session's totals", async () => {
    await using db = await database();
    await syncPrices(db.sql, { bundled: [entry], configured: [] });
    await addSession(db.sql, { id: 's1', model: 'priced-model', requests: [10] });

    await syncPrices(db.sql, { bundled: [{ ...entry, input: 3 }], configured: [] });

    expect(await stale(db.sql)).toEqual(['s1 totals']);
  });
});

// What a refresh says: the error it throws, or how many Sessions it refreshed.
const outcome = async (sql: SQL): Promise<string> => {
  try {
    return `refreshed ${String(await refreshSessionInsight(sql))}`;
  } catch (error) {
    return String(error);
  }
};

describe('a Session whose refresh fails', () => {
  test('holds up no other, is named, and is left after 3 tries until marked again', async () => {
    await using db = await database();
    await price(db.sql);
    await addSession(db.sql, { id: 'poison', model: 'priced-model', requests: [20] });
    await addSession(db.sql, { id: 's1', model: 'priced-model', requests: [10] });
    await db.sql`
      CREATE FUNCTION refuse_poison() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.session_id = 'poison' THEN RAISE EXCEPTION 'poisoned'; END IF;
        RETURN NEW;
      END
      $$
    `;
    await db.sql`
      CREATE TRIGGER refuse_poison BEFORE INSERT ON stored_session_totals
        FOR EACH ROW EXECUTE FUNCTION refuse_poison()
    `;
    await price(db.sql, 3_000_000);

    expect(await outcome(db.sql)).toMatch(/poison: .*poisoned/u);
    expect(await stale(db.sql)).toEqual(['poison totals']);
    expect(await outcome(db.sql)).toMatch(/poison/u);
    expect(await outcome(db.sql)).toMatch(/poison/u);
    expect(await outcome(db.sql)).toBe('refreshed 0');

    await addRequest(db.sql, 'poison', 'poison-late', 30);

    expect(await outcome(db.sql)).toMatch(/poison/u);
  });
});

describe('the refresh order', () => {
  test('stores the Sessions with the latest requests first', async () => {
    await using db = await database();
    for (let i = 0; i < 2; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- fixtures in order.
      await addSession(db.sql, { id: `s${String(i).padStart(2, '0')}`, requests: [i * 10] });
    }
    await price(db.sql);

    await refreshSessionInsight(db.sql, { budgetMs: 0 });

    expect(await stale(db.sql)).toEqual(['s00 totals']);
  });
});

// A second connection, one transaction at a time, standing for a writer that
// commits after a parse and a refresh ran beside it.
const writer = (url: URL) => new SQL({ max: 1, url: url.href });

describe('a change committed while a refresh runs beside it', () => {
  test('a process stored as a new Session is parsed and refreshed', async () => {
    await using db = await database();
    const w = writer(db.url);
    await w`BEGIN`;
    await w`
      INSERT INTO harness_processes (system, harness, pid, started_at, ended_at, end_missed, cwd,
        peak_rss_bytes, last_seen_at, sent_at)
      VALUES ('laptop-1', 'claude-code', 100, ${at(0)}, ${at(600)}, false, ${CWD}, 0, ${at(300)}, ${at(600)})
    `;
    await addSession(db.sql, { id: 's1', requests: [10, 200, 590] });
    await w`COMMIT`;
    await w.close();

    await refreshSessionInsight(db.sql);

    expect(await differences(db.sql)).toEqual([]);
  });

  test('a process stored as an old Session gains requests that are refreshed', async () => {
    await using db = await database();
    await addSession(db.sql, { id: 's1', requests: [-86_400] });
    const w = writer(db.url);
    await w`BEGIN`;
    await w`
      INSERT INTO harness_processes (system, harness, pid, started_at, ended_at, end_missed, cwd,
        peak_rss_bytes, last_seen_at, sent_at)
      VALUES ('laptop-1', 'claude-code', 100, ${at(0)}, ${at(600)}, false, ${CWD}, 0, ${at(300)}, ${at(600)})
    `;
    await addRequest(db.sql, 's1', 's1-a', 10);
    await addRequest(db.sql, 's1', 's1-b', 590);
    await refreshSessionInsight(db.sql);
    await w`COMMIT`;
    await w.close();

    await refreshSessionInsight(db.sql);

    expect(await differences(db.sql)).toEqual([]);
  });

  test('a price change as a new Session is parsed and refreshed', async () => {
    await using db = await database();
    await price(db.sql);
    const w = writer(db.url);
    await w`BEGIN`;
    await w`UPDATE model_prices SET input_per_mtok = 5000000 WHERE model = 'priced-model'`;
    await addSession(db.sql, { id: 's1', model: 'priced-model', requests: [10, 200] });
    await w`COMMIT`;
    await w.close();

    await refreshSessionInsight(db.sql);

    expect(await differences(db.sql)).toEqual([]);
  });

  test('a request stored while the refresh holds its Session is refreshed later', async () => {
    await using db = await database();
    await linkedSession(db.sql);
    await db.sql`
      SELECT mark_sessions_stale(ARRAY['claude-code'], ARRAY['laptop-1'], ARRAY['claude-code'],
                                 ARRAY['s1'], true, true)
    `;
    const w = writer(db.url);
    await w`BEGIN`;
    await addRequest(w, 's1', 's1-late', 400);
    await refreshSessionInsight(db.sql, { budgetMs: 0 });
    await w`COMMIT`;
    await w.close();

    await refreshSessionInsight(db.sql);

    expect(await differences(db.sql)).toEqual([]);
  });
});

test('a database migrated to version 21 refreshes once migrated to the latest', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 21),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;
  await addSession(db.sql, { id: 's1', requests: [10, 20] });

  await migrate(db.sql);
  await price(db.sql);

  expect(await refreshSessionInsight(db.sql)).toBe(1);
  expect(await differences(db.sql)).toEqual([]);
});

test('a database migrated to version 31 has model totals beside its Session totals once migrated to the latest', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 31),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;
  await price(db.sql);
  await addSession(db.sql, { id: 's1', model: 'priced-model', requests: [10, 20] });
  expect(await refreshSessionInsight(db.sql)).toBe(0);

  await migrate(db.sql);

  expect(await stale(db.sql)).toEqual([]);
  expect(await modelTotals(db.sql, 's1')).toEqual(['priced-model: 2, 10, 0']);
  const [{ sessions, models }] = await db.sql`
    SELECT (SELECT sum(requests) FROM insight.session_totals)::int AS sessions,
           (SELECT sum(requests) FROM insight.session_model_totals)::int AS models
  `;
  expect(models).toBe(sessions);
  expect(await differences(db.sql)).toEqual([]);
});
