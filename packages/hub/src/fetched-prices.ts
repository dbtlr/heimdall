import type { SQL } from 'bun';

import { MIGRATION_LOCK } from './migrations.ts';
import type { Fetch } from './outbound-http.ts';
import { fetchPriceList } from './price-list.ts';
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

// The most a listed price may be, in dollars per million tokens, before the
// model is skipped as a likely unit error, priced or not: a per-token price
// slipped by a million is far over it.
const PLAUSIBLE_CEILING = 10_000;

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

// "Its input price over 200,000 prompt tokens, 6 a million tokens", naming
// one price of `entry`.
const priceName = (entry: ListedEntry, kind: (typeof KINDS)[number], price: number) => {
  const tier =
    entry.promptOver === undefined
      ? ''
      : ` over ${entry.promptOver.toLocaleString('en-US')} prompt tokens`;
  return `Its ${kind} price${tier}, ${String(price)} a million tokens`;
};

// Why some price of `listed` is over the plausible ceiling, or undefined when
// none is.
const implausible = (listed: ListedModel) => {
  for (const entry of listed.entries) {
    for (const kind of KINDS) {
      const price = entry[kind];
      if (price !== undefined && price > PLAUSIBLE_CEILING) {
        return `${priceName(entry, kind, price)}, is over the ceiling of ${String(PLAUSIBLE_CEILING)} a million tokens, as a unit error would be.`;
      }
    }
  }
  return undefined;
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
      // Floating-point division can put an exact 100 times a hair over it.
      if (ratio > UNIT_ERROR_RATIO * (1 + 1e-9)) {
        return `${priceName(wanted, kind, listed)}, differs more than ${String(UNIT_ERROR_RATIO)} times from the ${String(now)} in force today, as a unit error would.`;
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
  const ceiling = implausible(listed);
  if (ceiling !== undefined) {
    return { kind: 'skipped', reason: ceiling };
  }
  if (!priced) {
    return {
      kind: 'rows',
      rows: listed.entries.map((entry) => toRow(entry, BACKFILL_FROM, entry.contextWindow)),
    };
  }
  const wanted = wantedEntries(listed, inForce);
  // A configured tier gets nothing, so its price is never compared.
  for (const entry of wanted.filter((e) => inForce.get(minPromptTokens(e))?.rank !== CONFIGURED)) {
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

// Where a fetch falls in the order fetches started: the next number of a
// database sequence `serve` and `prices update` share, taken as text since it
// is a bigint. It needs no clock, so a clock that steps leaves the order right.
export type FetchStart = { number: string };

export const startFetch = async (sql: SQL): Promise<FetchStart> => {
  const [row]: { number: string }[] =
    await sql`SELECT nextval('fetched_price_fetches')::text AS number`;
  if (row === undefined) {
    throw new Error('The fetched price sequence gave no number.');
  }
  return { number: row.number };
};

// Adds the entries `models`, read from the price list, call for, in one
// transaction that holds the lock migrations and price loads take, and says
// what it added and which models it skipped as likely unit errors. "Today" is
// the UTC day on the database's clock once the lock is held, so a fetch that
// waited for the lock past midnight dates its entries the day it reads the
// prices in force, not the day it started. When it adds nothing it writes no
// price, so a fetch that changes no price marks no totals stale.
// `start` is what `startFetch` gave the fetch of `models` before it waited on
// the network. Under the lock, a fetch that started before the last applied one
// applies nothing, so overlapping fetches that apply out of order never leave
// an older list standing over a newer one.
export const applyFetchedPrices = (sql: SQL, models: readonly ListedModel[], start: FetchStart) =>
  sql.begin(async (tx): Promise<AppliedPrices> => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`;
    const [last]: { superseded: boolean }[] = await tx`
      SELECT last_fetch > ${start.number}::bigint AS superseded FROM fetched_price_applies
    `;
    if (last?.superseded === true) {
      return { added: [], skipped: [] };
    }
    await tx`
      INSERT INTO fetched_price_applies (last_fetch) VALUES (${start.number}::bigint)
      ON CONFLICT (only_row) DO UPDATE SET last_fetch = EXCLUDED.last_fetch
    `;
    const [clock]: { today: string }[] =
      await tx`SELECT to_char((clock_timestamp() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS today`;
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

// Fetches the list at `source` and adds the entries it calls for. What it
// skipped includes the models the list gives that do not fit the table. A
// fetch that started before one already applied applies nothing: the newer
// list stands. Throws when the fetch fails, having changed nothing.
export const updateFetchedPrices = async ({
  fetch,
  signal,
  source,
  sql,
}: {
  fetch: Fetch;
  signal?: AbortSignal;
  source: URL;
  sql: SQL;
}): Promise<AppliedPrices> => {
  // Taken before the network wait, outside the lock, and compared under it.
  const start = await startFetch(sql);
  const list = await fetchPriceList({ fetch, source, ...(signal === undefined ? {} : { signal }) });
  const { added, skipped } = await applyFetchedPrices(sql, list.models, start);
  return { added, skipped: [...list.skipped, ...skipped] };
};

// "Added fetched prices for gpt-6.2-sol from 2020-01-01: every prompt, and
// over 272,000 prompt tokens."
export const describeAdded = ({ from, model, tiers }: AddedPrices) => {
  const names = tiers.map((over) =>
    over === 0 ? 'every prompt' : `over ${over.toLocaleString('en-US')} prompt tokens`,
  );
  const listed =
    names.length > 1
      ? `${names.slice(0, -1).join(', ')}, and ${names.at(-1) ?? ''}`
      : names.join('');
  return `Added fetched prices for ${model} from ${from}: ${listed}.`;
};

// A model skipped as a possible unit error, as serve and the command warn of it.
export const describeSuspect = ({ model, reason }: SkippedModel) =>
  `Skipped ${model}, a possible unit error: ${reason}`;

const DAY_MS = 86_400_000;

// Runs `fetch` unless it last succeeded within a day, by `now`, so a pass that
// runs hourly fetches once a day and tries a failed fetch again on its next run.
// A clock that went back since the last success makes it due, so it never stalls.
export const dailyFetch = ({ fetch, now }: { fetch: () => Promise<void>; now: () => number }) => {
  let succeededAt: number | undefined;
  return async () => {
    const elapsed = succeededAt === undefined ? undefined : now() - succeededAt;
    if (elapsed !== undefined && elapsed >= 0 && elapsed < DAY_MS) {
      return;
    }
    const startedAt = now();
    await fetch();
    succeededAt = startedAt;
  };
};
