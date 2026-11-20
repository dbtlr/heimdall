import type { SQL } from 'bun';

import { MIGRATION_LOCK } from './migrations.ts';
import type { ListedEntry, ListedModel, SkippedModel } from './price-list.ts';

// What a fetch adds to `fetched_model_prices` (ADR-0024, docs/spec.md "What a
// fetch adds"): dated entries, tier by tier, never changing or deleting an
// entry from an earlier day. A model the table has never priced gets the
// list's entries from 2020-01-01, so its earlier requests are priced. For a
// model it prices, each tier is compared with the entry in force today at
// exactly that tier, by the views' order: a configured tier is the operator's
// and gets nothing, a tier whose prices match gets nothing, and any other tier
// gets the list's entry from today.

// The day a model the table has never priced is priced from.
const BACKFILL_FROM = '2020-01-01';

// How far a price may stray from the one in force before the model is skipped
// as a likely unit error.
const UNIT_ERROR_RATIO = 100;

const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'] as const;
type Prices = Pick<ListedEntry, (typeof KINDS)[number]>;

// The source ranks the views order by within a tier.
const CONFIGURED = 0;

// The entry that wins at one exact tier today: its source's rank, prices, and window.
type InForce = { contextWindow: number; minPromptTokens: number; prices: Prices; rank: number };

// A model a fetch added entries for, from `from`, at each tier's `promptOver`,
// 0 for its base.
export type AddedPrices = { from: string; model: string; tiers: number[] };

export type AppliedPrices = { added: AddedPrices[]; skipped: SkippedModel[] };

// An entry to write, as `fetched_model_prices` holds it.
type FetchedRow = {
  cache_read_per_mtok: number | null;
  cache_write_1h_per_mtok: number | null;
  cache_write_5m_per_mtok: number | null;
  context_window: number;
  input_per_mtok: number;
  min_prompt_tokens: number;
  model: string;
  output_per_mtok: number;
  valid_from: string;
};

const minPromptTokens = (entry: Pick<ListedEntry, 'promptOver'>) => (entry.promptOver ?? -1) + 1;

// Prices match when every kind is equal, and an absent price matches only an
// absent one.
const samePrices = (a: Prices, b: Prices) => KINDS.every((kind) => a[kind] === b[kind]);

// Of the tiers in `tiers`, keyed by their smallest prompt, the highest that a
// prompt of `prompt` tokens reaches.
const tierFor = <T>(tiers: ReadonlyMap<number, T>, prompt: number) => {
  const reached = [...tiers.keys()].filter((min) => min <= prompt);
  return reached.length === 0 ? undefined : tiers.get(Math.max(...reached));
};

// Why the price of some kind in `wanted` looks like a unit error next to the
// one a request in its tier gets today, or undefined when none does. Only two
// present, nonzero prices are compared.
const unitError = (wanted: ListedEntry, today: Prices | undefined) => {
  for (const kind of KINDS) {
    const now = today?.[kind];
    const listed = wanted[kind];
    if (now !== undefined && listed !== undefined && now > 0 && listed > 0) {
      const ratio = Math.max(now / listed, listed / now);
      if (ratio > UNIT_ERROR_RATIO) {
        const tier =
          wanted.promptOver === undefined
            ? 'base'
            : `over ${wanted.promptOver.toLocaleString('en-US')} prompt tokens`;
        return `Its ${kind} price ${tier}, ${String(listed)} a million tokens, is more than ${String(UNIT_ERROR_RATIO)} times off the ${String(now)} in force today, as a unit error would be.`;
      }
    }
  }
  return undefined;
};

// The entries `listed` wants for a model the table prices: one per tier the
// list gives, and for each tier in force today that the list no longer names,
// one at the list's price for a prompt one token over that tier's threshold.
const wantedEntries = (listed: ListedModel, inForce: ReadonlyMap<number, InForce>) => {
  const byTier = new Map(listed.entries.map((entry) => [minPromptTokens(entry), entry]));
  const retired = [...inForce.keys()]
    .filter((min) => !byTier.has(min))
    .flatMap((min) => {
      const price = tierFor(byTier, min);
      return price === undefined ? [] : [{ ...price, promptOver: min - 1 }];
    });
  return [...listed.entries, ...retired];
};

const toRow = (entry: ListedEntry, validFrom: string, contextWindow: number): FetchedRow => ({
  cache_read_per_mtok: entry.cacheRead ?? null,
  cache_write_1h_per_mtok: entry.cacheWrite1h ?? null,
  cache_write_5m_per_mtok: entry.cacheWrite5m ?? null,
  context_window: contextWindow,
  input_per_mtok: entry.input,
  min_prompt_tokens: minPromptTokens(entry),
  model: entry.model,
  output_per_mtok: entry.output,
  valid_from: `${validFrom}T00:00:00Z`,
});

// The rows one listed model adds, or why it is skipped. `inForce` holds the
// model's winning entry at each exact tier today, and `priced` whether the
// table has any entry for it.
const plan = (
  listed: ListedModel,
  {
    inForce,
    priced,
    today,
  }: { inForce: ReadonlyMap<number, InForce>; priced: boolean; today: string },
): { kind: 'rows'; rows: FetchedRow[] } | { kind: 'skipped'; reason: string } => {
  if (!priced) {
    return {
      kind: 'rows',
      rows: listed.entries.map((entry) => toRow(entry, BACKFILL_FROM, entry.contextWindow)),
    };
  }
  const wanted = wantedEntries(listed, inForce);
  for (const entry of wanted) {
    const reason = unitError(entry, tierFor(inForce, minPromptTokens(entry))?.prices);
    if (reason !== undefined) {
      return { kind: 'skipped', reason };
    }
  }
  const base = inForce.get(0);
  return {
    kind: 'rows',
    rows: wanted.flatMap((entry) => {
      const current = inForce.get(minPromptTokens(entry));
      if (
        current?.rank === CONFIGURED ||
        (current !== undefined && samePrices(current.prices, entry))
      ) {
        return [];
      }
      const window = current?.contextWindow ?? base?.contextWindow ?? entry.contextWindow;
      return [toRow(entry, today, window)];
    }),
  };
};

type InForceRow = {
  cache_read: string | null;
  cache_write_1h: string | null;
  cache_write_5m: string | null;
  context_window: string;
  input: string;
  min_prompt_tokens: string;
  model: string;
  output: string;
  rank: number;
};

// A cache price read back, absent when the entry has none, so it matches only
// an absent one.
const optional = (name: 'cacheRead' | 'cacheWrite1h' | 'cacheWrite5m', value: string | null) =>
  value === null ? {} : { [name]: Number(value) };

const inForceOf = (row: InForceRow): InForce => ({
  contextWindow: Number(row.context_window),
  minPromptTokens: Number(row.min_prompt_tokens),
  prices: {
    input: Number(row.input),
    output: Number(row.output),
    ...optional('cacheRead', row.cache_read),
    ...optional('cacheWrite1h', row.cache_write_1h),
    ...optional('cacheWrite5m', row.cache_write_5m),
  },
  rank: row.rank,
});

// Adds the entries `models`, read from the price list, call for, in one
// transaction that holds the lock migrations and price loads take, and says
// what it added and which models it skipped as likely unit errors. "Today" is
// the UTC day on the transaction's clock. It writes nothing when it adds
// nothing, so a fetch that changes no price marks no totals stale.
export const applyFetchedPrices = (sql: SQL, models: readonly ListedModel[]) =>
  sql.begin(async (tx): Promise<AppliedPrices> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`;
    const [clock]: { today: string }[] =
      await tx`SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS today`;
    const today = clock?.today ?? '';
    const names = JSON.stringify(models.map(({ model }) => model));
    const priced: { model: string }[] = await tx`
      WITH listed AS (SELECT jsonb_array_elements_text(${names}::text::jsonb) AS model)
      SELECT DISTINCT p.model FROM (
        SELECT model FROM model_prices UNION ALL SELECT model FROM fetched_model_prices
      ) p JOIN listed USING (model)
    `;
    // Each listed model's winning entry at each exact tier today, by the views' order.
    const rows: InForceRow[] = await tx`
      WITH listed AS (SELECT jsonb_array_elements_text(${names}::text::jsonb) AS model)
      SELECT DISTINCT ON (p.model, p.min_prompt_tokens)
             p.model, p.min_prompt_tokens::text, p.rank, p.input_per_mtok::text AS input,
             p.output_per_mtok::text AS output, p.cache_read_per_mtok::text AS cache_read,
             p.cache_write_5m_per_mtok::text AS cache_write_5m,
             p.cache_write_1h_per_mtok::text AS cache_write_1h, p.context_window::text
      FROM (
        SELECT m.model, m.valid_from, m.input_per_mtok, m.output_per_mtok, m.cache_read_per_mtok,
               m.cache_write_5m_per_mtok, m.cache_write_1h_per_mtok, m.context_window,
               m.min_prompt_tokens, CASE WHEN m.source = 'configured' THEN 0 ELSE 2 END AS rank
        FROM model_prices m
        UNION ALL
        SELECT f.model, f.valid_from, f.input_per_mtok, f.output_per_mtok, f.cache_read_per_mtok,
               f.cache_write_5m_per_mtok, f.cache_write_1h_per_mtok, f.context_window,
               f.min_prompt_tokens, 1 AS rank
        FROM fetched_model_prices f
      ) p JOIN listed USING (model)
      WHERE p.valid_from <= ${`${today}T00:00:00Z`}::timestamptz
      ORDER BY p.model, p.min_prompt_tokens, p.rank, p.valid_from DESC
    `;
    const inForce = new Map<string, Map<number, InForce>>();
    for (const row of rows) {
      const entry = inForceOf(row);
      const tiers = inForce.get(row.model) ?? new Map<number, InForce>();
      tiers.set(entry.minPromptTokens, entry);
      inForce.set(row.model, tiers);
    }
    const pricedModels = new Set(priced.map(({ model }) => model));
    const added: AddedPrices[] = [];
    const skipped: SkippedModel[] = [];
    const writes: FetchedRow[] = [];
    for (const listed of models) {
      const planned = plan(listed, {
        inForce: inForce.get(listed.model) ?? new Map(),
        priced: pricedModels.has(listed.model),
        today,
      });
      if (planned.kind === 'skipped') {
        skipped.push({ kind: 'suspect', model: listed.model, reason: planned.reason });
      } else if (planned.rows.length > 0) {
        writes.push(...planned.rows);
        added.push({
          from: planned.rows[0]?.valid_from.slice(0, 10) ?? today,
          model: listed.model,
          tiers: planned.rows
            .map((row) => Math.max(0, row.min_prompt_tokens - 1))
            .toSorted((a, b) => a - b),
        });
      }
    }
    if (writes.length > 0) {
      // One statement, so the write marks the totals stale once. A later fetch
      // the same day replaces that day's entry for a tier.
      await tx`
        INSERT INTO fetched_model_prices
        SELECT * FROM jsonb_populate_recordset(NULL::fetched_model_prices, ${JSON.stringify(writes)}::text::jsonb)
        ON CONFLICT (model, valid_from, min_prompt_tokens) DO UPDATE SET
          input_per_mtok = EXCLUDED.input_per_mtok,
          output_per_mtok = EXCLUDED.output_per_mtok,
          cache_read_per_mtok = EXCLUDED.cache_read_per_mtok,
          cache_write_5m_per_mtok = EXCLUDED.cache_write_5m_per_mtok,
          cache_write_1h_per_mtok = EXCLUDED.cache_write_1h_per_mtok,
          context_window = EXCLUDED.context_window
      `;
    }
    return { added, skipped };
  });
