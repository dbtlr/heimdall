import { readFile } from 'node:fs/promises';

import type { SQL } from 'bun';
import { z } from 'zod';

import { describeError } from './errors.ts';
import { MIGRATION_LOCK } from './migrations.ts';
import type { PriceEntry } from './prices.ts';
import { UNATTRIBUTED_MODEL } from './session-insight.ts';

// The price table the `insight` views read (migration 16): the bundled prices
// and the ones the Hub's configuration adds, loaded when `serve` starts. The
// table is derived from them and replaced whole, never edited.

// A day in UTC, as `YYYY-MM-DD`, that exists.
const day = z.string().refine((text) => {
  const at = Date.parse(`${text}T00:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(text) &&
    !Number.isNaN(at) &&
    new Date(at).toISOString().startsWith(text)
  );
}, 'Use a day such as 2026-07-01.');

const price = z.number().nonnegative().finite();

const RESERVED_MODEL = `The model ${UNATTRIBUTED_MODEL} is reserved for usage a Harness cannot attribute to a model, and is never priced.`;

// A model id as the views match it: without the `-YYYYMMDD` suffix a dated
// id carries, which the views strip from a request's model, and never the
// reserved `unknown`.
const model = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_./@+-]*$/u, 'Use a model id.')
  .refine((id) => !/-\d{8}$/u.test(id), 'Name the model without a date suffix.')
  .refine((id) => id !== UNATTRIBUTED_MODEL, RESERVED_MODEL);

const priceEntry = z
  .strictObject({
    cacheRead: price.optional(),
    cacheWrite1h: price.optional(),
    cacheWrite5m: price.optional(),
    contextWindow: z.number().int().positive(),
    input: price,
    model,
    output: price,
    promptOver: z.number().int().positive().optional(),
    validFrom: day,
  })
  .transform((parsed): PriceEntry => {
    // Optional keys are present only when given, as `PriceEntry` allows.
    const { cacheRead, cacheWrite1h, cacheWrite5m, promptOver, ...rest } = parsed;
    return {
      ...rest,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
      ...(cacheWrite5m === undefined ? {} : { cacheWrite5m }),
      ...(promptOver === undefined ? {} : { promptOver }),
    };
  });

const overrides = z
  .strictObject({ prices: z.array(priceEntry) })
  .superRefine(({ prices }, context) => {
    const seen = new Set<string>();
    for (const [index, { model: id, promptOver, validFrom }] of prices.entries()) {
      const key = `${id}@${validFrom}@${String(promptOver ?? 0)}`;
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          message: `More than one entry for ${id} from ${validFrom} over ${String(promptOver ?? 0)} prompt tokens.`,
          path: ['prices', index],
        });
      }
      seen.add(key);
    }
  });

// The entries of a price overrides file: a JSON object whose `prices` list holds
// entries shaped as the bundled table's (prices.ts), dollars per million
// tokens. Throws when the text is not one.
export const parsePriceOverrides = (text: string): PriceEntry[] => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('It is not valid JSON.');
  }
  const parsed = overrides.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'The file'}: ${issue.message}`)
        .join(' '),
    );
  }
  return parsed.data.prices;
};

// The entries of the overrides file at `path`. A failure names the path.
export const loadPriceOverrides = async (path: string): Promise<PriceEntry[]> => {
  try {
    return parsePriceOverrides(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read the price overrides in ${path}: ${describeError(error)}`, {
      cause: error,
    });
  }
};

// Replaces the price table with `bundled` and `configured` entries, and leaves
// it untouched when it already holds exactly those. Both stay in it: where a
// configured entry and a bundled one share a model, a date, and a prompt tier,
// the views choose the configured one. The replacement holds the lock
// migrations take, so Hubs that start together load it one at a time. An
// entry for the reserved `unknown` model, bundled or configured, refuses the
// load before it touches the table.
export const syncPrices = async (
  sql: SQL,
  { bundled, configured }: { bundled: readonly PriceEntry[]; configured: readonly PriceEntry[] },
): Promise<void> => {
  if ([...bundled, ...configured].some((entry) => entry.model === UNATTRIBUTED_MODEL)) {
    throw new Error(RESERVED_MODEL);
  }
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK}))`;
    const rows = [
      ...bundled.map((entry) => ({ entry, source: 'bundled' })),
      ...configured.map((entry) => ({ entry, source: 'configured' })),
    ].map(({ entry: p, source }) => ({
      cache_read_per_mtok: p.cacheRead ?? null,
      cache_write_1h_per_mtok: p.cacheWrite1h ?? null,
      cache_write_5m_per_mtok: p.cacheWrite5m ?? null,
      context_window: p.contextWindow,
      input_per_mtok: p.input,
      min_prompt_tokens: (p.promptOver ?? -1) + 1,
      model: p.model,
      output_per_mtok: p.output,
      source,
      valid_from: `${p.validFrom}T00:00:00Z`,
    }));
    const loaded = JSON.stringify(rows);
    // Writing the same prices again would mark every Session's totals stale.
    const [changed]: { changed: boolean }[] = await tx`
      WITH loaded AS (
        SELECT * FROM jsonb_populate_recordset(NULL::model_prices, ${loaded}::text::jsonb)
      )
      SELECT EXISTS (TABLE loaded EXCEPT TABLE model_prices)
          OR EXISTS (TABLE model_prices EXCEPT TABLE loaded) AS changed
    `;
    if (changed?.changed === true) {
      await tx`DELETE FROM model_prices`;
      await tx`
        INSERT INTO model_prices
        SELECT * FROM jsonb_populate_recordset(NULL::model_prices, ${loaded}::text::jsonb)
      `;
    }
  });
};
