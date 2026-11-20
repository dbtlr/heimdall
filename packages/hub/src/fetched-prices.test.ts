import { beforeAll, describe, expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { applyFetchedPrices } from './fetched-prices.ts';
import { MIGRATION_LOCK } from './migrations.ts';
import type { ListedEntry, ListedModel } from './price-list.ts';
import { syncPrices } from './price-table.ts';
import type { PriceEntry } from './prices.ts';
import { refreshSessionInsight } from './stored-insight.ts';
import { migratedDatabase, startTestServer } from './testing/postgres.ts';
import { seedRequests } from './testing/requests.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

const MODEL = 'test-model';
const DAY_MS = 86_400_000;

// The fetch's day and the day before it, in UTC, as the database's clock has
// them.
const days = async (sql: SQL) => {
  const [row]: { today: string }[] =
    await sql`SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS today`;
  const today = row?.today ?? '';
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  return { today, yesterday };
};

// A model's entry as the list gives it: dollars per million tokens, and the
// list's window.
const LISTED: ListedEntry = {
  cacheRead: 0.3,
  cacheWrite5m: 3.75,
  contextWindow: 1_000_000,
  input: 3,
  model: MODEL,
  output: 15,
};
const listed = (...entries: Partial<ListedEntry>[]): ListedModel => ({
  entries: entries.map((entry) => ({ ...LISTED, ...entry })),
  model: entries[0]?.model ?? MODEL,
});

// The same prices as a table entry, with the table's own window.
const TABLED: PriceEntry = {
  cacheRead: 0.3,
  cacheWrite5m: 3.75,
  contextWindow: 200_000,
  input: 3,
  model: MODEL,
  output: 15,
  validFrom: '2026-01-01',
};

const prepared = async (prices: { bundled?: PriceEntry[]; configured?: PriceEntry[] } = {}) => {
  const db = await migratedDatabase();
  await syncPrices(db.sql, { bundled: [], configured: [], ...prices });
  await db.sql`DELETE FROM stale_ranges`;
  return db;
};

const fetchedRows = async (sql: SQL) => {
  const rows: {
    model: string;
    valid_from: string;
    min_prompt_tokens: string;
    input: string;
    output: string;
    cache_read: string | null;
    context_window: string;
  }[] = await sql`
    SELECT model, to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS valid_from,
           min_prompt_tokens::text, input_per_mtok::text AS input, output_per_mtok::text AS output,
           cache_read_per_mtok::text AS cache_read, context_window::text
    FROM fetched_model_prices ORDER BY model, valid_from, min_prompt_tokens
  `;
  return rows.map(
    (r) =>
      `${r.model} ${r.valid_from} over ${String(Number(r.min_prompt_tokens) - 1)}: ${String(Number(r.input))}/${String(Number(r.output))}/${r.cache_read === null ? '-' : String(Number(r.cache_read))} window ${r.context_window}`,
  );
};

const staleMarks = async (sql: SQL) => {
  const [row]: { n: number }[] = await sql`SELECT count(*)::int AS n FROM stale_ranges`;
  return row?.n;
};

const costs = async (sql: SQL) => {
  const rows: { cost_usd: string | null; request_id: string }[] = await sql`
    SELECT request_id, cost_usd FROM insight.requests ORDER BY request_id
  `;
  return Object.fromEntries(
    rows.map((row) => [row.request_id, row.cost_usd === null ? null : Number(row.cost_usd)]),
  );
};

describe('a model the table has never priced', () => {
  test('is priced from 2020-01-01 at the list price and window, so its earlier requests are priced after a refresh', async () => {
    await using db = await prepared();
    await seedRequests(db.sql, [{ at: '2024-05-01T00:00:00Z', id: 'old', input: 100_000 }]);
    await refreshSessionInsight(db.sql);
    const [before]: { cost_usd: string | null }[] =
      await db.sql`SELECT cost_usd FROM insight.session_totals`;
    expect(before?.cost_usd).toBeNull();

    const applied = await applyFetchedPrices(db.sql, [
      listed({}, { input: 6, promptOver: 200_000 }),
    ]);

    expect(applied).toEqual({
      added: [{ from: '2020-01-01', model: MODEL, tiers: [0, 200_000] }],
      skipped: [],
    });
    expect(await fetchedRows(db.sql)).toEqual([
      'test-model 2020-01-01 over -1: 3/15/0.3 window 1000000',
      'test-model 2020-01-01 over 200000: 6/15/0.3 window 1000000',
    ]);
    await refreshSessionInsight(db.sql);
    const [after]: { cost_usd: string | null }[] =
      await db.sql`SELECT cost_usd FROM insight.session_totals`;
    expect(Number(after?.cost_usd)).toBe(0.3);
  });
});

describe('a model the table already prices', () => {
  test('takes a changed price from the fetch day, keeping the table window, and earlier days keep the old price', async () => {
    await using db = await prepared({ bundled: [{ ...TABLED, input: 4 }] });
    const { today, yesterday } = await days(db.sql);
    await seedRequests(db.sql, [
      { at: `${yesterday}T23:59:59Z`, id: 'a-yesterday', input: 1_000_000 },
      { at: `${today}T00:00:00Z`, id: 'b-today', input: 1_000_000 },
    ]);

    const applied = await applyFetchedPrices(db.sql, [listed({})]);

    expect(applied.added).toEqual([{ from: today, model: MODEL, tiers: [0] }]);
    expect(await fetchedRows(db.sql)).toEqual([
      `test-model ${today} over -1: 3/15/0.3 window 200000`,
    ]);
    expect(await costs(db.sql)).toEqual({ 'a-yesterday': 4, 'b-today': 3 });
  });

  test('an unchanged list writes nothing and marks no totals', async () => {
    await using db = await prepared({ bundled: [TABLED] });

    const applied = await applyFetchedPrices(db.sql, [listed({ contextWindow: 5 })]);

    expect(applied).toEqual({ added: [], skipped: [] });
    expect(await fetchedRows(db.sql)).toEqual([]);
    expect(await staleMarks(db.sql)).toBe(0);
  });

  test('an absent price matches only an absent one', async () => {
    const { cacheRead: _absent, ...withoutCacheRead } = LISTED;
    await using db = await prepared({ bundled: [TABLED] });

    const applied = await applyFetchedPrices(db.sql, [
      { entries: [withoutCacheRead], model: MODEL },
    ]);

    expect(applied.added.map((a) => a.model)).toEqual([MODEL]);
  });

  test('a second fetch of the same list adds nothing, after a new model, a change, or a dropped tier', async () => {
    await using db = await prepared({
      bundled: [TABLED, { ...TABLED, input: 6, promptOver: 100_000 }],
    });
    const list = [listed({ input: 2 }), listed({ model: 'new-model' })];
    expect((await applyFetchedPrices(db.sql, list)).added).toHaveLength(2);
    await db.sql`DELETE FROM stale_ranges`;

    expect(await applyFetchedPrices(db.sql, list)).toEqual({ added: [], skipped: [] });
    expect(await staleMarks(db.sql)).toBe(0);
  });

  test('a second fetch the same day that finds a different price replaces that day entry', async () => {
    await using db = await prepared({ bundled: [{ ...TABLED, input: 4 }] });
    const { today } = await days(db.sql);

    await applyFetchedPrices(db.sql, [listed({ input: 3 })]);
    await applyFetchedPrices(db.sql, [listed({ input: 2 })]);

    expect(await fetchedRows(db.sql)).toEqual([
      `test-model ${today} over -1: 2/15/0.3 window 200000`,
    ]);
  });

  test('a new tier takes the window of the base entry in force today', async () => {
    await using db = await prepared({ bundled: [TABLED] });
    const { today } = await days(db.sql);

    await applyFetchedPrices(db.sql, [listed({}, { input: 6, promptOver: 272_000 })]);

    expect(await fetchedRows(db.sql)).toEqual([
      `test-model ${today} over 272000: 6/15/0.3 window 200000`,
    ]);
  });

  test('a new tier is written even at the prices a lower tier gives', async () => {
    await using db = await prepared({ bundled: [TABLED] });
    const { today } = await days(db.sql);

    await applyFetchedPrices(db.sql, [listed({}, { promptOver: 100_000 })]);

    expect(await fetchedRows(db.sql)).toEqual([
      `test-model ${today} over 100000: 3/15/0.3 window 200000`,
    ]);
  });

  test.each([
    ['5-minute', { cacheWrite5m: 4 }],
    ['1-hour', { cacheWrite1h: 7.5 }],
  ])('a change only to the %s cache-write price adds an entry', async (_name, change) => {
    await using db = await prepared({ bundled: [{ ...TABLED, cacheWrite1h: 6 }] });
    const { today } = await days(db.sql);

    const applied = await applyFetchedPrices(db.sql, [listed({ cacheWrite1h: 6, ...change })]);

    expect(applied.added).toEqual([{ from: today, model: MODEL, tiers: [0] }]);
  });

  test('takes the list window when the table has no entry in force today', async () => {
    await using db = await prepared({ bundled: [{ ...TABLED, validFrom: '2999-01-01' }] });
    const { today } = await days(db.sql);

    await applyFetchedPrices(db.sql, [listed({})]);

    expect(await fetchedRows(db.sql)).toEqual([
      `test-model ${today} over -1: 3/15/0.3 window 1000000`,
    ]);
  });

  test('keeps the entries of a model the list drops', async () => {
    await using db = await prepared();
    await applyFetchedPrices(db.sql, [listed({}), listed({ model: 'other-model' })]);

    await applyFetchedPrices(db.sql, [listed({ model: 'other-model' })]);

    expect(await fetchedRows(db.sql)).toHaveLength(2);
  });
});

describe('the entry a tier is compared with is the one the views price it by', () => {
  test('an older configured entry wins over a newer bundled one, so the tier gets nothing', async () => {
    await using db = await prepared({
      bundled: [{ ...TABLED, validFrom: '2026-06-01' }],
      configured: [{ ...TABLED, input: 5, validFrom: '2026-01-01' }],
    });

    expect(await applyFetchedPrices(db.sql, [listed({ input: 2 })])).toEqual({
      added: [],
      skipped: [],
    });
  });

  test('an older fetched entry wins over a newer bundled one', async () => {
    await using db = await prepared();
    await applyFetchedPrices(db.sql, [listed({})]);
    await syncPrices(db.sql, {
      bundled: [{ ...TABLED, input: 4, validFrom: '2026-06-01' }],
      configured: [],
    });

    expect(await applyFetchedPrices(db.sql, [listed({})])).toEqual({ added: [], skipped: [] });
  });

  test('of two fetched entries, the newer wins', async () => {
    await using db = await prepared();
    await applyFetchedPrices(db.sql, [listed({})]);
    await applyFetchedPrices(db.sql, [listed({ input: 4 })]);

    expect(await applyFetchedPrices(db.sql, [listed({ input: 4 })])).toEqual({
      added: [],
      skipped: [],
    });
  });
});

describe('a tier the list no longer gives stops applying from the fetch day', () => {
  test('a dropped tier takes the base price', async () => {
    await using db = await prepared({
      bundled: [TABLED, { ...TABLED, input: 6, promptOver: 100_000 }],
    });
    const { today, yesterday } = await days(db.sql);
    await seedRequests(db.sql, [
      { at: `${yesterday}T12:00:00Z`, id: 'a-yesterday', input: 200_000 },
      { at: `${today}T00:00:00Z`, id: 'b-today', input: 200_000 },
    ]);

    const applied = await applyFetchedPrices(db.sql, [listed({})]);

    expect(applied.added).toEqual([{ from: today, model: MODEL, tiers: [100_000] }]);
    expect(await costs(db.sql)).toEqual({ 'a-yesterday': 1.2, 'b-today': 0.6 });
  });

  test('a moved threshold takes the price the list now gives there', async () => {
    await using db = await prepared({
      bundled: [TABLED, { ...TABLED, input: 6, promptOver: 100_000 }],
    });
    const { today } = await days(db.sql);
    await seedRequests(db.sql, [
      { at: `${today}T00:00:00Z`, id: 'a-between', input: 150_000 },
      { at: `${today}T00:00:00Z`, id: 'b-over', input: 250_000 },
    ]);

    await applyFetchedPrices(db.sql, [listed({}, { input: 10, promptOver: 200_000 })]);

    expect(await costs(db.sql)).toEqual({ 'a-between': 0.45, 'b-over': 2.5 });
  });
});

describe('a configured entry belongs to the operator', () => {
  test('a configured tier gets nothing, and the other tiers still change', async () => {
    await using db = await prepared({
      bundled: [TABLED, { ...TABLED, input: 6, promptOver: 100_000 }],
      configured: [{ ...TABLED, input: 5, validFrom: '2026-06-01' }],
    });
    const { today } = await days(db.sql);

    const applied = await applyFetchedPrices(db.sql, [
      listed({ input: 2 }, { input: 7, promptOver: 100_000 }),
    ]);

    expect(applied.added).toEqual([{ from: today, model: MODEL, tiers: [100_000] }]);
    expect(await fetchedRows(db.sql)).toEqual([
      `test-model ${today} over 100000: 7/15/0.3 window 200000`,
    ]);
  });

  test('a configured entry wins in its tier over the fetched entry it was compared with', async () => {
    await using db = await prepared({ configured: [{ ...TABLED, input: 5 }] });
    await seedRequests(db.sql, [{ at: '2026-06-01T00:00:00Z', id: 'r', input: 1_000_000 }]);

    await applyFetchedPrices(db.sql, [listed({ input: 2 })]);

    expect(await costs(db.sql)).toEqual({ r: 5 });
  });
});

describe('a price that looks like a unit error', () => {
  test.each([
    ['more than 100 times', 3 * 101],
    ['less than a hundredth of', 3 / 101],
  ])('a price %s the one in force skips the model, and says so', async (_name, input) => {
    await using db = await prepared({ bundled: [TABLED] });

    const applied = await applyFetchedPrices(db.sql, [
      listed({ input }),
      listed({ model: 'other' }),
    ]);

    expect(applied.added.map((a) => a.model)).toEqual(['other']);
    expect(applied.skipped).toEqual([
      { kind: 'suspect', model: MODEL, reason: expect.stringContaining('input') },
    ]);
    expect(await fetchedRows(db.sql)).toEqual([
      'other 2020-01-01 over -1: 3/15/0.3 window 1000000',
    ]);
  });

  test.each([
    ['exactly 100 times is taken', 3, 300, []],
    ['exactly 100 times is taken where division rounds over 100', 0.57, 57, []],
    ['just over 100 times is skipped', 3, 300.000_001, [MODEL]],
  ])('a price %s', async (_name, inForce, input, skipped) => {
    await using db = await prepared({ bundled: [{ ...TABLED, input: inForce }] });

    const applied = await applyFetchedPrices(db.sql, [listed({ input })]);

    expect(applied.skipped.map((s) => s.model)).toEqual(skipped);
  });

  test('is judged against the price a request in the tier gets today, from a lower tier when the table has none there', async () => {
    await using db = await prepared({ bundled: [TABLED] });

    const applied = await applyFetchedPrices(db.sql, [
      listed({}, { input: 3000, promptOver: 100_000 }),
    ]);

    expect(applied.skipped.map((s) => s.model)).toEqual([MODEL]);
  });

  test('a tier whose entry in force today is configured is not compared, so the other tiers still change', async () => {
    await using db = await prepared({
      bundled: [TABLED, { ...TABLED, input: 6, promptOver: 100_000 }],
      configured: [{ ...TABLED, input: 900 }],
    });
    const { today } = await days(db.sql);

    const applied = await applyFetchedPrices(db.sql, [
      listed({}, { input: 7, promptOver: 100_000 }),
    ]);

    expect(applied).toEqual({
      added: [{ from: today, model: MODEL, tiers: [100_000] }],
      skipped: [],
    });
    expect(await fetchedRows(db.sql)).toEqual([
      `test-model ${today} over 100000: 7/15/0.3 window 200000`,
    ]);
  });

  test('only a tier configured at exactly its threshold escapes the 100 times check', async () => {
    await using db = await prepared({ bundled: [TABLED], configured: [{ ...TABLED, input: 3 }] });

    const applied = await applyFetchedPrices(db.sql, [
      listed({ input: 3 }, { input: 600, promptOver: 100_000 }),
    ]);

    expect(applied.added).toEqual([]);
    expect(applied.skipped.map((s) => [s.model, s.kind])).toEqual([[MODEL, 'suspect']]);
  });

  test('zero or absent prices are not compared', async () => {
    const { cacheRead: _absent, ...withoutCacheRead } = TABLED;
    await using db = await prepared({ bundled: [{ ...withoutCacheRead, output: 0 }] });

    const applied = await applyFetchedPrices(db.sql, [listed({ cacheRead: 300, output: 3000 })]);

    expect(applied.skipped).toEqual([]);
    expect(applied.added.map((a) => a.model)).toEqual([MODEL]);
  });
});

describe('a price over $10,000 per million tokens is implausible', () => {
  test('skips a model the table has never priced, so a corrected list later prices its history', async () => {
    await using db = await prepared();

    const applied = await applyFetchedPrices(db.sql, [listed({ input: 2_000_000 })]);

    expect(applied).toEqual({
      added: [],
      skipped: [
        {
          kind: 'suspect',
          model: MODEL,
          reason:
            'Its input price, 2000000 a million tokens, is over the ceiling of 10000 a million tokens, as a unit error would be.',
        },
      ],
    });
    expect(await fetchedRows(db.sql)).toEqual([]);
    expect((await applyFetchedPrices(db.sql, [listed({ input: 2 })])).added).toEqual([
      { from: '2020-01-01', model: MODEL, tiers: [0] },
    ]);
  });

  test('skips a model the table prices, in any tier and kind, even within 100 times of the price in force', async () => {
    await using db = await prepared({ bundled: [{ ...TABLED, cacheWrite5m: 200 }] });

    const applied = await applyFetchedPrices(db.sql, [
      listed({ cacheWrite5m: 200 }, { cacheWrite5m: 10_001, promptOver: 100_000 }),
    ]);

    expect(applied.skipped).toEqual([
      {
        kind: 'suspect',
        model: MODEL,
        reason:
          'Its cacheWrite5m price over 100,000 prompt tokens, 10001 a million tokens, is over the ceiling of 10000 a million tokens, as a unit error would be.',
      },
    ]);
    expect(await fetchedRows(db.sql)).toEqual([]);
  });

  test('takes a price of exactly $10,000 per million tokens', async () => {
    await using db = await prepared();

    const applied = await applyFetchedPrices(db.sql, [listed({ output: 10_000 })]);

    expect(applied.skipped).toEqual([]);
    expect(applied.added.map((a) => a.model)).toEqual([MODEL]);
  });
});

test('waits for the lock migrations and price loads take', async () => {
  await using db = await prepared();
  const holder = await db.sql.reserve();
  try {
    await holder`BEGIN`;
    await holder`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`;
    let done = false;
    const applying = (async () => {
      await applyFetchedPrices(db.sql, [listed({})]);
      done = true;
    })();
    await Bun.sleep(200);
    expect(done).toBe(false);
    await holder`COMMIT`;
    await applying;
    expect(await fetchedRows(db.sql)).toHaveLength(1);
  } finally {
    await holder.release();
  }
});

test('loading the bundled and configured prices again leaves the fetched entries alone', async () => {
  await using db = await prepared({ bundled: [{ ...TABLED, input: 4 }] });
  await applyFetchedPrices(db.sql, [listed({}), listed({ model: 'new-model' })]);
  const fetched = await fetchedRows(db.sql);

  await syncPrices(db.sql, { bundled: [], configured: [{ ...TABLED, input: 9 }] });

  expect(await fetchedRows(db.sql)).toEqual(fetched);
  expect(fetched).toHaveLength(2);
});
