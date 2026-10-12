import { readFile } from 'node:fs/promises';

import type { SQL } from 'bun';
import { z } from 'zod';

import { describeError } from './errors.ts';
import type { PriceEntry } from './prices.ts';

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

// A model id as the views match it: without the `-YYYYMMDD` suffix a dated
// id carries, which the views strip from a request's model.
const model = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_./@+-]*$/u, 'Use a model id.')
  .refine((id) => !/-\d{8}$/u.test(id), 'Name the model without a date suffix.');

const priceEntry = z
  .strictObject({
    cacheRead: price.optional(),
    cacheWrite1h: price.optional(),
    cacheWrite5m: price.optional(),
    contextWindow: z.number().int().positive(),
    input: price,
    model,
    output: price,
    validFrom: day,
  })
  .transform((parsed): PriceEntry => {
    // Optional keys are present only when given, as `PriceEntry` allows.
    const { cacheRead, cacheWrite1h, cacheWrite5m, ...rest } = parsed;
    return {
      ...rest,
      ...(cacheRead === undefined ? {} : { cacheRead }),
      ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
      ...(cacheWrite5m === undefined ? {} : { cacheWrite5m }),
    };
  });

const overrides = z
  .strictObject({ prices: z.array(priceEntry) })
  .superRefine(({ prices }, context) => {
    const seen = new Set<string>();
    for (const [index, { model: id, validFrom }] of prices.entries()) {
      const key = `${id}@${validFrom}`;
      if (seen.has(key)) {
        context.addIssue({
          code: 'custom',
          message: `More than one entry for ${id} from ${validFrom}.`,
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

// Replaces the price table with `bundled` and `configured` entries. Both stay
// in it: where a configured entry and a bundled one share a model and a date,
// the views choose the configured one.
export const syncPrices = (
  sql: SQL,
  { bundled, configured }: { bundled: readonly PriceEntry[]; configured: readonly PriceEntry[] },
): Promise<void> =>
  sql.begin(async (tx) => {
    await tx`DELETE FROM model_prices`;
    const rows = [
      ...bundled.map((p) => ({ price: p, source: 'bundled' })),
      ...configured.map((p) => ({ price: p, source: 'configured' })),
    ];
    for (const { price: p, source } of rows) {
      // oxlint-disable-next-line no-await-in-loop -- a table of a few dozen rows.
      await tx`
        INSERT INTO model_prices (
          model, valid_from, source, input_per_mtok, output_per_mtok, cache_read_per_mtok,
          cache_write_5m_per_mtok, cache_write_1h_per_mtok, context_window
        )
        VALUES (
          ${p.model}, ${`${p.validFrom}T00:00:00Z`}::timestamptz, ${source}, ${p.input},
          ${p.output}, ${p.cacheRead ?? null}, ${p.cacheWrite5m ?? null},
          ${p.cacheWrite1h ?? null}, ${p.contextWindow}
        )
      `;
    }
  });
