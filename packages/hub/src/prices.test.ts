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

  test('only a trailing eight-digit date is a suffix: a model id ending in a version keeps its own entry', async () => {
    const family = { ...PRICE, input: 1, model: 'claude-opus-4' };
    const version = { ...PRICE, input: 2, model: 'claude-opus-4-6' };
    const minor = { ...PRICE, input: 3, model: 'claude-sonnet-4-5' };
    const base = { ...PRICE, input: 4, model: 'claude-sonnet-4' };
    await using db = await prepared({ bundled: [family, version, minor, base] });
    const at = '2026-03-01T00:00:00Z';
    await seed(db.sql, [
      { at, id: 'a-version', input: 1_000_000, model: 'claude-opus-4-6' },
      { at, id: 'b-version-dated', input: 1_000_000, model: 'claude-opus-4-6-20260101' },
      { at, id: 'c-family-dated', input: 1_000_000, model: 'claude-opus-4-20250514' },
      { at, id: 'd-minor', input: 1_000_000, model: 'claude-sonnet-4-5' },
      { at, id: 'e-base-dated', input: 1_000_000, model: 'claude-sonnet-4-20250514' },
      { at, id: 'f-unknown-version', input: 1_000_000, model: 'claude-opus-4-9' },
    ]);

    expect(await costs(db.sql)).toEqual({
      'a-version': 2,
      'b-version-dated': 2,
      'c-family-dated': 1,
      'd-minor': 3,
      'e-base-dated': 4,
      'f-unknown-version': null,
    });
  });

  test('a 1-hour write count above the cache write total never makes the 5-minute term negative', async () => {
    await using db = await prepared({ bundled: [PRICE] });
    await seed(db.sql, [{ at: '2026-03-01T00:00:00Z', id: 'r1' }]);
    await db.sql`
      UPDATE projected_requests
      SET cache_write_tokens = 1000000, cache_write_5m_tokens = 0, cache_write_1h_tokens = 3000000
    `;

    // Only the 3M 1-hour writes at 10 count; the 5-minute remainder is zero, not -2M at 5.
    expect(await costs(db.sql)).toEqual({ r1: 30 });
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

// A model that reprices the whole request above a prompt size, as Claude Haiku
// 5.5 does above 100,000 tokens: input at 4, or 8 above the threshold.
const BASE_TIER: PriceEntry = { ...PRICE, input: 4, output: 20 };
const HIGH_TIER: PriceEntry = { ...PRICE, input: 8, output: 40, promptOver: 100_000 };
const TIERED: PriceEntry[] = [BASE_TIER, HIGH_TIER];

describe('a prompt over a threshold reprices the whole request', () => {
  test('a request at the threshold uses the base prices, and one token over uses the higher ones', async () => {
    await using db = await prepared({ bundled: TIERED });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', id: 'at', input: 100_000, output: 1_000_000 },
      { at: '2026-03-01T00:00:00Z', id: 'over', input: 100_001, output: 1_000_000 },
    ]);

    // The output is repriced too: 20 at the threshold, 40 over it.
    expect(await costs(db.sql)).toEqual({ at: 20.4, over: 40.800_008 });
  });

  test('the prompt is input, cache reads, and cache writes together', async () => {
    // The higher tier doubles the cache prices too, so a prompt counted
    // without its cache reads or its cache writes lands in the wrong tier.
    await using db = await prepared({
      bundled: [BASE_TIER, { ...HIGH_TIER, cacheRead: 1, cacheWrite1h: 20, cacheWrite5m: 10 }],
    });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', cacheRead: 50_000, cacheWrite5m: 50_000, id: 'at' },
      { at: '2026-03-01T00:00:00Z', cacheRead: 50_000, cacheWrite1h: 50_001, id: 'over' },
    ]);

    // 50k reads at 0.5 and 50k 5-minute writes at 5; then 50k reads at 1 and 50,001 1-hour writes at 20.
    expect(await costs(db.sql)).toEqual({ at: 0.275, over: 1.050_02 });
  });

  test('the tier shows in the request context window and fill', async () => {
    await using db = await prepared({
      bundled: [
        { ...PRICE, contextWindow: 200_000 },
        { ...HIGH_TIER, contextWindow: 1_000_000 },
      ],
    });
    await seed(db.sql, [{ at: '2026-03-01T00:00:00Z', id: 'over', input: 500_000 }]);

    const [row]: Record<string, string>[] = await db.sql`
      SELECT context_window, context_fill_percent FROM insight.requests
    `;

    expect([Number(row?.context_window), Number(row?.context_fill_percent)]).toEqual([
      1_000_000, 50,
    ]);
  });

  test('a dated change to one tier leaves the other tier at its own price', async () => {
    await using db = await prepared({
      bundled: [...TIERED, { ...BASE_TIER, input: 1, validFrom: '2026-06-01' }],
    });
    await seed(db.sql, [
      { at: '2026-05-31T00:00:00Z', id: 'a-small-before', input: 10_000 },
      { at: '2026-05-31T00:00:00Z', id: 'b-large-before', input: 200_000 },
      { at: '2026-06-01T00:00:00Z', id: 'c-small-after', input: 10_000 },
      { at: '2026-06-01T00:00:00Z', id: 'd-large-after', input: 200_000 },
    ]);

    // Only the base tier changed on 1 June.
    expect(await costs(db.sql)).toEqual({
      'a-small-before': 0.04,
      'b-large-before': 1.6,
      'c-small-after': 0.01,
      'd-large-after': 1.6,
    });
  });

  test('a dated change to every tier applies to each from its date', async () => {
    await using db = await prepared({
      bundled: [
        ...TIERED,
        { ...BASE_TIER, input: 1, validFrom: '2026-06-01' },
        { ...HIGH_TIER, input: 2, validFrom: '2026-06-01' },
      ],
    });
    await seed(db.sql, [
      { at: '2026-05-31T00:00:00Z', id: 'a-base-before', input: 10_000 },
      { at: '2026-05-31T00:00:00Z', id: 'b-high-before', input: 200_000 },
      { at: '2026-06-01T00:00:00Z', id: 'c-base-after', input: 10_000 },
      { at: '2026-06-01T00:00:00Z', id: 'd-high-after', input: 200_000 },
    ]);

    expect(await costs(db.sql)).toEqual({
      'a-base-before': 0.04,
      'b-high-before': 1.6,
      'c-base-after': 0.01,
      'd-high-after': 0.4,
    });
  });

  test('an override replaces a tier of the same model and date, and leaves the other tier', async () => {
    await using db = await prepared({
      bundled: TIERED,
      configured: [{ ...HIGH_TIER, input: 6 }],
    });
    await seed(db.sql, [
      { at: '2026-03-01T00:00:00Z', id: 'a-base', input: 10_000 },
      { at: '2026-03-01T00:00:00Z', id: 'b-high', input: 200_000 },
    ]);

    expect(await costs(db.sql)).toEqual({ 'a-base': 0.04, 'b-high': 1.2 });
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

test('the main conversation totals have no cost when a main conversation request is unpriced', async () => {
  await using db = await prepared({ bundled: [PRICE] });
  await seed(db.sql, [
    { at: '2026-03-01T00:00:00Z', id: 'main-priced', input: 1_000_000 },
    { at: '2026-03-01T00:00:00Z', id: 'main-unpriced', model: 'mystery-model' },
    { at: '2026-03-01T00:00:00Z', id: 'sub', input: 1_000_000 },
  ]);
  await db.sql`UPDATE projected_requests SET agent_id = 'a1' WHERE request_id = 'sub'`;

  const [main]: Record<string, string | null>[] = await db.sql`
    SELECT cost_usd, priced_cost_usd, unpriced_requests FROM insight.main_conversation_totals
  `;

  expect(main?.cost_usd).toBeNull();
  expect(Number(main?.priced_cost_usd)).toBe(4);
  expect(Number(main?.unpriced_requests)).toBe(1);
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
    const keys = BUNDLED_PRICES.map(
      (entry) => `${entry.model}@${entry.validFrom}@${String(entry.promptOver ?? 0)}`,
    );
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

  test('gives every tiered model a base entry from the same date, so small requests are priced', () => {
    for (const tier of BUNDLED_PRICES.filter((entry) => entry.promptOver !== undefined)) {
      expect(
        BUNDLED_PRICES.some(
          (entry) =>
            entry.model === tier.model &&
            entry.validFrom === tier.validFrom &&
            entry.promptOver === undefined,
        ),
      ).toBe(true);
    }
  });

  test('reprices Claude Haiku 5.5 over 100,000 prompt tokens as the pricing page lists', () => {
    const haiku = BUNDLED_PRICES.filter((entry) => entry.model === 'claude-haiku-5-5');

    expect(haiku.map(({ promptOver, ...prices }) => [promptOver, prices])).toEqual([
      [
        undefined,
        {
          cacheRead: 0.01,
          cacheWrite1h: 0.2,
          cacheWrite5m: 0.125,
          contextWindow: 1_000_000,
          input: 0.1,
          model: 'claude-haiku-5-5',
          output: 0.5,
          validFrom: '2026-10-07',
        },
      ],
      [
        100_000,
        {
          cacheRead: 0.05,
          cacheWrite1h: 1,
          cacheWrite5m: 0.625,
          contextWindow: 1_000_000,
          input: 0.5,
          model: 'claude-haiku-5-5',
          output: 2.5,
          validFrom: '2026-10-07',
        },
      ],
    ]);
  });

  test('reprices gpt-6.1-sol over 272,000 prompt tokens at twice input, cache, and write and 1.5 times output', () => {
    const [base, high] = BUNDLED_PRICES.filter((entry) => entry.model === 'gpt-6.1-sol');

    expect([base?.input, base?.cacheRead, base?.cacheWrite5m, base?.output]).toEqual([
      2, 0.1, 2.5, 10,
    ]);
    expect(high?.promptOver).toBe(272_000);
    expect([high?.input, high?.cacheRead, high?.cacheWrite5m, high?.output]).toEqual([
      4, 0.2, 5, 15,
    ]);
    expect(base?.contextWindow).toBe(1_050_000);
  });

  test('prices Claude Sonnet 5.5 cache reads at 0.05 times input', () => {
    expect(BUNDLED_PRICES.find((entry) => entry.model === 'claude-sonnet-5-5')?.cacheRead).toBe(
      0.1,
    );
  });

  test('names each model without a date suffix, so a dated id can match it', () => {
    for (const entry of BUNDLED_PRICES) {
      expect(entry.model).not.toMatch(/-\d{8}$/u);
    }
  });

  test('concurrent loads all succeed and leave one full table', async () => {
    await using db = await testDatabase();
    await migrate(db.sql);

    await Promise.all(
      Array.from({ length: 3 }, () =>
        syncPrices(db.sql, { bundled: BUNDLED_PRICES, configured: [{ ...PRICE }] }),
      ),
    );

    const [row]: { n: number }[] = await db.sql`SELECT count(*)::int AS n FROM model_prices`;
    expect(row?.n).toBe(BUNDLED_PRICES.length + 1);
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

  test('reads a prompt threshold, and keeps two entries that differ only in it', () => {
    const tiers = JSON.stringify({
      prices: [
        { contextWindow: 1, input: 1, model: 'm', output: 1, validFrom: '2026-01-01' },
        {
          contextWindow: 1,
          input: 2,
          model: 'm',
          output: 2,
          promptOver: 100_000,
          validFrom: '2026-01-01',
        },
      ],
    });

    expect(parsePriceOverrides(tiers).map((entry) => entry.promptOver)).toEqual([
      undefined,
      100_000,
    ]);
  });

  test.each([
    ['text that is not JSON', 'not json'],
    [
      'a prompt threshold of zero',
      '{"prices":[{"model":"m","validFrom":"2026-01-01","input":1,"output":1,"contextWindow":1,"promptOver":0}]}',
    ],
    [
      'two entries for one model, date, and threshold',
      '{"prices":[{"model":"m","validFrom":"2026-01-01","input":1,"output":1,"contextWindow":1,"promptOver":5},{"model":"m","validFrom":"2026-01-01","input":2,"output":1,"contextWindow":1,"promptOver":5}]}',
    ],
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
