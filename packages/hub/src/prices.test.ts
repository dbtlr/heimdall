import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SQL } from 'bun';

import { migrate } from './migrations.ts';
import { loadPriceOverrides, parsePriceOverrides, syncPrices } from './price-table.ts';
import type { PriceEntry } from './prices.ts';
import { BUNDLED_PRICES } from './prices.ts';
import { startTestServer, testDatabase } from './testing/postgres.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

// A model no real one shares a name with, priced so every kind of token costs
// a different, round amount per million: dollars per million tokens.
const MODEL = 'test-model';
const PRICE: PriceEntry = {
  cacheRead: 0.5,
  cacheWrite1h: 10,
  cacheWrite5m: 5,
  contextWindow: 200_000,
  input: 4,
  model: MODEL,
  output: 20,
  validFrom: '2026-01-01',
};

type Row = {
  at: string;
  cacheRead?: number;
  cacheWrite1h?: number | null;
  cacheWrite5m?: number | null;
  id: string;
  input?: number;
  model?: string;
  output?: number;
  session?: string;
};

// Seeds a Session's requests as the projection would leave them, with the
// parser current, so the `insight` views read them.
const seed = async (sql: SQL, rows: Row[], { session = 's-1' }: { session?: string } = {}) => {
  await sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now()) ON CONFLICT DO NOTHING`;
  await sql`
    INSERT INTO transcript_generations (id, system, source, path, opened_at, last_upload_at)
    VALUES (1, 'laptop-1', 'claude-code', 'projects/p/s.jsonl', now(), now())
    ON CONFLICT DO NOTHING
  `;
  await sql`INSERT INTO current_parsers (harness, version) VALUES ('claude-code', 1) ON CONFLICT DO NOTHING`;
  await sql`
    INSERT INTO projected_sessions (harness, parser_version, system, source, session_id)
    VALUES ('claude-code', 1, 'laptop-1', 'claude-code', ${session})
    ON CONFLICT DO NOTHING
  `;
  for (const row of rows) {
    const cacheWrite5m = row.cacheWrite5m === undefined ? 0 : row.cacheWrite5m;
    const cacheWrite1h = row.cacheWrite1h === undefined ? 0 : row.cacheWrite1h;
    // oxlint-disable-next-line no-await-in-loop -- a few rows, in order.
    await sql`
      INSERT INTO projected_requests (
        harness, parser_version, system, source, session_id, request_id, at, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens, generation, byte_offset
      )
      VALUES (
        'claude-code', 1, 'laptop-1', 'claude-code', ${session}, ${row.id}, ${row.at},
        ${row.model ?? MODEL}, ${row.input ?? 0}, ${row.output ?? 0}, ${row.cacheRead ?? 0},
        ${(cacheWrite5m ?? 0) + (cacheWrite1h ?? 0)}, ${cacheWrite5m}, ${cacheWrite1h}, 1, 0
      )
    `;
  }
};

const prepared = async (prices: { bundled?: PriceEntry[]; configured?: PriceEntry[] }) => {
  const db = await testDatabase();
  await migrate(db.sql);
  await syncPrices(db.sql, { bundled: [], configured: [], ...prices });
  return db;
};

const costs = async (sql: SQL) => {
  const rows: { cost_usd: string | null; request_id: string }[] = await sql`
    SELECT request_id, cost_usd FROM insight.requests ORDER BY request_id
  `;
  return Object.fromEntries(
    rows.map((row) => [row.request_id, row.cost_usd === null ? null : Number(row.cost_usd)]),
  );
};

describe('a request is priced at list prices', () => {
  test('each kind of token costs its own price per million', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [
      {
        at: '2026-03-01T00:00:00Z',
        cacheRead: 2_000_000,
        cacheWrite1h: 100_000,
        cacheWrite5m: 1_000_000,
        id: 'r1',
        input: 1_000_000,
        output: 500_000,
      },
    ]);

    // 4 + 10 (500k output at 20) + 1 (2M cache reads at 0.5) + 5 (1M 5m writes at 5) + 1 (100k 1h writes at 10)
    expect(await costs(db.sql)).toEqual({ r1: 21 });
  });

  test('a cache write the Harness did not split costs the 5-minute price', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [{ at: '2026-03-01T00:00:00Z', id: 'r1' }]);
    await db.sql`
      UPDATE projected_requests
      SET cache_write_tokens = 1000000, cache_write_5m_tokens = NULL, cache_write_1h_tokens = NULL
    `;

    expect(await costs(db.sql)).toEqual({ r1: 5 });
  });

  test('a model id with a date suffix takes its undated model price', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', id: 'r1', input: 1_000_000, model: `${MODEL}-20260101` },
    ]);

    expect(await costs(db.sql)).toEqual({ r1: 4 });
  });

  test('tokens of a kind the model has no price for leave the request unpriced', async () => {
    const { cacheWrite1h: _unpriced, ...withoutLongWrites } = PRICE;
    await using db = await prepared({ bundled: [withoutLongWrites] });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', cacheWrite1h: 1000, id: 'no-price-for-kind' },
      { at: '2026-03-01T00:00:00Z', id: 'fine', input: 1_000_000 },
    ]);

    expect(await costs(db.sql)).toEqual({ fine: 4, 'no-price-for-kind': null });
  });
});

describe('a price applies from its date', () => {
  const OLD: PriceEntry = { ...PRICE, input: 4, validFrom: '2026-01-01' };
  const NEW: PriceEntry = { ...PRICE, input: 1, validFrom: '2026-06-01' };

  test('a request before a price change uses the old price, and one after it the new', async () => {
    await using db = await prepared({ bundled: [OLD, NEW] });
    await seed(db.sql, [
      { at: '2026-05-31T23:59:59Z', id: 'before', input: 1_000_000 },
      { at: '2026-06-01T00:00:00Z', id: 'on', input: 1_000_000 },
      { at: '2026-09-01T00:00:00Z', id: 'after', input: 1_000_000 },
    ]);

    expect(await costs(db.sql)).toEqual({ after: 1, before: 4, on: 1 });
  });

  test('a request before a model has any price is unpriced', async () => {
    await using db = await prepared({ bundled: [OLD] });
    await seed(db.sql, [{ at: '2025-12-31T23:59:59Z', id: 'early', input: 1_000_000 }]);

    expect(await costs(db.sql)).toEqual({ early: null });
  });

  test('a price starts at midnight UTC whatever the database time zone is', async () => {
    // The test database runs in America/New_York.
    await using db = await prepared({ bundled: [OLD, NEW] });
    await seed(db.sql, [
      { at: '2026-05-31T20:00:00-04:00', id: 'new-york-evening', input: 1_000_000 },
      { at: '2026-05-31T19:59:00-04:00', id: 'earlier', input: 1_000_000 },
    ]);

    // 20:00 in New York on 31 May is 00:00 UTC on 1 June.
    expect(await costs(db.sql)).toEqual({ earlier: 4, 'new-york-evening': 1 });
  });
});

describe('a configured price overrides the bundled one', () => {
  test('an override with the bundled entry model and date wins', async () => {
    await using db = await prepared({
      bundled: [PRICE],
      configured: [{ ...PRICE, input: 3 }],
    });
    await seed(db.sql, [{ at: '2026-03-01T00:00:00Z', id: 'r1', input: 1_000_000 }]);

    expect(await costs(db.sql)).toEqual({ r1: 3 });
  });

  test('a dated override does not reprice requests before its date', async () => {
    await using db = await prepared({
      bundled: [PRICE],
      configured: [{ ...PRICE, input: 3, validFrom: '2026-06-01' }],
    });
    await seed(db.sql, [
      { at: '2026-05-31T00:00:00Z', id: 'before', input: 1_000_000 },
      { at: '2026-06-01T00:00:00Z', id: 'after', input: 1_000_000 },
    ]);

    expect(await costs(db.sql)).toEqual({ after: 3, before: 4 });
  });

  test('a bundled price dated after an override takes over from its date', async () => {
    await using db = await prepared({
      bundled: [PRICE, { ...PRICE, input: 2, validFrom: '2026-09-01' }],
      configured: [{ ...PRICE, input: 3, validFrom: '2026-06-01' }],
    });
    await seed(db.sql, [
      { at: '2026-07-01T00:00:00Z', id: 'between', input: 1_000_000 },
      { at: '2026-10-01T00:00:00Z', id: 'later', input: 1_000_000 },
    ]);

    expect(await costs(db.sql)).toEqual({ between: 3, later: 2 });
  });

  test('an override prices a model the bundled table does not know', async () => {
    await using db = await prepared({ bundled: [], configured: [PRICE] });
    await seed(db.sql, [{ at: '2026-03-01T00:00:00Z', id: 'r1', input: 1_000_000 }]);

    expect(await costs(db.sql)).toEqual({ r1: 4 });
  });

  test('syncing again replaces the prices, so a removed override stops applying', async () => {
    await using db = await prepared({ bundled: [PRICE], configured: [{ ...PRICE, input: 3 }] });
    await seed(db.sql, [{ at: '2026-03-01T00:00:00Z', id: 'r1', input: 1_000_000 }]);

    await syncPrices(db.sql, { bundled: [PRICE], configured: [] });

    expect(await costs(db.sql)).toEqual({ r1: 4 });
  });
});

describe('an unpriced request is never free', () => {
  test('an unknown model reads null, not zero, even with no tokens', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', id: 'unknown', input: 1000, model: 'mystery-model' },
      { at: '2026-03-01T00:00:00Z', id: 'empty', model: '<synthetic>' },
    ]);

    expect(await costs(db.sql)).toEqual({ empty: null, unknown: null });
  });

  test('a Session total that includes one says so and has no total cost', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', id: 'priced', input: 1_000_000 },
      { at: '2026-03-01T00:00:00Z', id: 'unknown', input: 1000, model: 'mystery-model' },
    ]);

    const [totals]: Record<string, string | null>[] = await db.sql`
      SELECT cost_usd, priced_cost_usd, unpriced_requests FROM insight.session_totals
    `;

    expect(totals?.cost_usd).toBeNull();
    expect(Number(totals?.priced_cost_usd)).toBe(4);
    expect(Number(totals?.unpriced_requests)).toBe(1);
  });

  test('a Session total with every request priced is their sum, and no request is unpriced', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', id: 'a', input: 1_000_000 },
      { at: '2026-03-01T00:00:00Z', id: 'b', output: 1_000_000 },
    ]);

    const [totals]: Record<string, string | null>[] = await db.sql`
      SELECT cost_usd, priced_cost_usd, unpriced_requests FROM insight.session_totals
    `;

    expect(Number(totals?.cost_usd)).toBe(24);
    expect(Number(totals?.priced_cost_usd)).toBe(24);
    expect(Number(totals?.unpriced_requests)).toBe(0);
  });

  test('a Session with no requests costs nothing and has none unpriced', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, []);

    const [totals]: Record<string, string | null>[] = await db.sql`
      SELECT cost_usd, priced_cost_usd, unpriced_requests FROM insight.session_totals
    `;

    expect(Number(totals?.cost_usd)).toBe(0);
    expect(totals?.priced_cost_usd).toBeNull();
    expect(Number(totals?.unpriced_requests)).toBe(0);
  });

  test('the main conversation totals leave a subagent unpriced request out', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', id: 'main', input: 1_000_000 },
      { at: '2026-03-01T00:00:00Z', id: 'sub', model: 'mystery-model' },
    ]);
    await db.sql`UPDATE projected_requests SET agent_id = 'a1' WHERE request_id = 'sub'`;

    const [main]: Record<string, string | null>[] = await db.sql`
      SELECT cost_usd, unpriced_requests FROM insight.main_conversation_totals
    `;
    const [whole]: Record<string, string | null>[] = await db.sql`
      SELECT cost_usd, unpriced_requests FROM insight.session_totals
    `;

    expect([Number(main?.cost_usd), Number(main?.unpriced_requests)]).toEqual([4, 0]);
    expect([whole?.cost_usd, Number(whole?.unpriced_requests)]).toEqual([null, 1]);
  });
});

describe('context fill', () => {
  test('is the request context as a percentage of the model context window', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [
      {
        at: '2026-03-01T00:00:00Z',
        cacheRead: 30_000,
        cacheWrite5m: 10_000,
        id: 'r1',
        input: 10_000,
      },
    ]);

    const [row]: Record<string, string | null>[] = await db.sql`
      SELECT context_tokens, context_window, context_fill_percent FROM insight.requests
    `;

    expect(Number(row?.context_tokens)).toBe(50_000);
    expect(Number(row?.context_window)).toBe(200_000);
    expect(Number(row?.context_fill_percent)).toBe(25);
  });

  test('is null for a model with no price, which has no known window', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', id: 'r1', input: 5, model: 'mystery-model' },
    ]);

    const [row]: Record<string, string | null>[] = await db.sql`
      SELECT context_window, context_fill_percent FROM insight.requests
    `;

    expect(row).toEqual({ context_fill_percent: null, context_window: null });
  });
});

test('no projected table stores a cost or a price', async () => {
  await using db = await testDatabase();
  await migrate(db.sql);

  const columns: { column_name: string; table_name: string }[] = await db.sql`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name LIKE 'projected\\_%'
      AND (column_name ILIKE '%cost%' OR column_name ILIKE '%price%' OR column_name ILIKE '%usd%')
  `;

  expect(columns).toEqual([]);
});

describe('the bundled table', () => {
  test('holds one entry per model and date, each with a window and non-negative prices', () => {
    const keys = BUNDLED_PRICES.map((entry) => `${entry.model}@${entry.validFrom}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const entry of BUNDLED_PRICES) {
      expect(entry.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(Number.isNaN(Date.parse(entry.validFrom))).toBe(false);
      expect(entry.contextWindow).toBeGreaterThan(0);
      for (const price of [
        entry.input,
        entry.output,
        entry.cacheRead,
        entry.cacheWrite5m,
        entry.cacheWrite1h,
      ]) {
        expect(price === undefined || price >= 0).toBe(true);
      }
    }
  });

  test('names each model without a date suffix, so a dated id can match it', () => {
    for (const entry of BUNDLED_PRICES) {
      expect(entry.model).not.toMatch(/-\d{8}$/u);
    }
  });

  test('loads into a migrated database', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);

    await syncPrices(db.sql, { bundled: BUNDLED_PRICES, configured: [] });

    const [row]: { n: number }[] = await db.sql`SELECT count(*)::int AS n FROM model_prices`;
    expect(row?.n).toBe(BUNDLED_PRICES.length);
  });
});

describe('a price overrides file', () => {
  const FILE = JSON.stringify({
    prices: [
      {
        cacheRead: 0.1,
        contextWindow: 128_000,
        input: 1,
        model: 'my-model',
        output: 2,
        validFrom: '2026-07-01',
      },
    ],
  });

  test('reads entries with the bundled table fields', () => {
    expect(parsePriceOverrides(FILE)).toEqual([
      {
        cacheRead: 0.1,
        contextWindow: 128_000,
        input: 1,
        model: 'my-model',
        output: 2,
        validFrom: '2026-07-01',
      },
    ]);
  });

  test.each([
    ['text that is not JSON', 'not json'],
    ['no prices list', '{}'],
    ['an entry with no date', '{"prices":[{"model":"m","input":1,"output":1,"contextWindow":1}]}'],
    [
      'a date that is not a day',
      '{"prices":[{"model":"m","validFrom":"2026-13-45","input":1,"output":1,"contextWindow":1}]}',
    ],
    [
      'a negative price',
      '{"prices":[{"model":"m","validFrom":"2026-01-01","input":-1,"output":1,"contextWindow":1}]}',
    ],
    [
      'an unknown field',
      '{"prices":[{"model":"m","validFrom":"2026-01-01","input":1,"output":1,"contextWindow":1,"cheap":true}]}',
    ],
    [
      'a model id with a date suffix',
      '{"prices":[{"model":"m-20260101","validFrom":"2026-01-01","input":1,"output":1,"contextWindow":1}]}',
    ],
    [
      'two entries for one model and date',
      '{"prices":[{"model":"m","validFrom":"2026-01-01","input":1,"output":1,"contextWindow":1},{"model":"m","validFrom":"2026-01-01","input":2,"output":1,"contextWindow":1}]}',
    ],
  ])('rejects %s', (_name, text) => {
    expect(() => parsePriceOverrides(text)).toThrow();
  });

  test('loads from a path, and names the path when it cannot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'heimdall-prices-'));
    try {
      const path = join(dir, 'prices.json');
      await writeFile(path, FILE);
      expect(await loadPriceOverrides(path)).toHaveLength(1);
      const missing = await loadPriceOverrides(join(dir, 'missing.json')).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((missing as Error).message).toContain('missing.json');
      await writeFile(path, '{}');
      const invalid = await loadPriceOverrides(path).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((invalid as Error).message).toContain('prices.json');
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
