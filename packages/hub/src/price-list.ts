import { describeError } from './errors.ts';
import { followRedirects, hasCredentials, readCapped } from './outbound-http.ts';
import type { Fetch } from './outbound-http.ts';
import { checkPriceEntry } from './price-table.ts';
import type { PriceEntry } from './prices.ts';
import { rounded } from './prices.ts';
import { HUB_VERSION } from './version.ts';

// Reading LiteLLM's public price list (ADR-0024, docs/spec.md "Fetched
// prices"): a JSON object keyed by model, each entry priced per token. The
// Hub reads the Anthropic and OpenAI models in chat and responses modes at
// standard prices, and ignores batch, flex, and priority prices and cache-write
// TTLs no Harness reports.

export const LITELLM_PRICE_LIST =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

// Where the Hub fetches the list from, or `off`, which stops the fetch.
export type PriceSource = { kind: 'off' } | { kind: 'list'; url: URL };

// The price source `text` names: `off`, or an `https://` URL, or an `http://`
// one for a list served nearby. Undefined for anything else, a URL with a user
// name or password included, since a fetch sends no credentials.
export const parsePriceSource = (text: string): PriceSource | undefined => {
  if (text === 'off') {
    return { kind: 'off' };
  }
  const url = URL.parse(text);
  return url !== null &&
    !hasCredentials(url) &&
    (url.protocol === 'https:' || url.protocol === 'http:')
    ? { kind: 'list', url }
    : undefined;
};

// One tier the list gives a model, as an entry of the price table without its
// date, which the fetch decides. `contextWindow` is the list's
// `max_input_tokens` on every tier.
export type ListedEntry = Omit<PriceEntry, 'validFrom'>;

// A model the list prices: its base entry first, then each tier by threshold.
export type ListedModel = { entries: ListedEntry[]; model: string };

// A model the Hub skips, and why: `unfit` when the list's entry does not fit
// the price table, `suspect` when a price looks like a unit error.
export type SkippedModel = { kind: 'suspect' | 'unfit'; model: string; reason: string };

export type PriceList = { models: ListedModel[]; skipped: SkippedModel[] };

const PROVIDERS = new Set(['anthropic', 'openai']);
const MODES = new Set(['chat', 'responses']);

// The list's field for each price of an entry. A tier's field adds
// `_above_<N>k_tokens`.
const FIELDS = {
  cacheRead: 'cache_read_input_token_cost',
  cacheWrite1h: 'cache_creation_input_token_cost_above_1hr',
  cacheWrite5m: 'cache_creation_input_token_cost',
  input: 'input_cost_per_token',
  output: 'output_cost_per_token',
} as const;

const TIER_FIELD = new RegExp(`^(?:${Object.values(FIELDS).join('|')})_above_(\\d+)k_tokens$`, 'u');
const DATE_SUFFIX = /^(.+)-(\d{8})$/u;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// A per-token price as dollars per million tokens, rounded to a millionth of a
// dollar. Anything but a number is passed on for the entry's rules to refuse.
const perMillion = (value: unknown) => (typeof value === 'number' ? rounded(value * 1e6) : value);

// The prices of one tier: the base when `suffix` is empty.
const tierPrices = (fields: Record<string, unknown>, suffix: string) =>
  Object.fromEntries(
    Object.entries(FIELDS)
      .filter(([, field]) => fields[`${field}${suffix}`] !== undefined)
      .map(([name, field]) => [name, perMillion(fields[`${field}${suffix}`])]),
  );

class SkipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SkipError';
  }
}

// The entries `fields` gives `model`, or a SkipError saying why it has none.
const modelEntries = (model: string, fields: Record<string, unknown>): ListedEntry[] => {
  const contextWindow = fields.max_input_tokens;
  if (fields[FIELDS.input] === undefined) {
    throw new SkipError('It has no input price.');
  }
  if (fields[FIELDS.output] === undefined) {
    throw new SkipError('It has no output price.');
  }
  if (contextWindow === undefined) {
    throw new SkipError('It has no max_input_tokens.');
  }
  if (fields[FIELDS.input] === 0 && fields[FIELDS.output] === 0) {
    throw new SkipError('Its input and output prices are both 0.');
  }
  const thresholds = [
    ...new Set(
      Object.keys(fields).flatMap((field) => {
        const n = TIER_FIELD.exec(field)?.[1];
        return n === undefined ? [] : [Number(n) * 1000];
      }),
    ),
  ].toSorted((a, b) => a - b);
  return [undefined, ...thresholds].map((promptOver) => {
    const suffix = promptOver === undefined ? '' : `_above_${String(promptOver / 1000)}k_tokens`;
    const tier: Record<string, unknown> = tierPrices(fields, suffix);
    if (promptOver !== undefined && (tier.input === undefined || tier.output === undefined)) {
      throw new SkipError(
        `Its tier over ${promptOver.toLocaleString('en-US')} prompt tokens lacks an input or an output price.`,
      );
    }
    tier.contextWindow = contextWindow;
    tier.model = model;
    if (promptOver !== undefined) {
      tier.promptOver = promptOver;
    }
    // The date is the fetch's to give; any valid one checks the rest.
    tier.validFrom = '2020-01-01';
    const checked = checkPriceEntry(tier);
    if (checked.kind === 'unfit') {
      throw new SkipError(`It does not fit the price table: ${checked.problem}`);
    }
    const { validFrom: _undated, ...entry } = checked.entry;
    return entry;
  });
};

// Whether a key dated `date`, undefined when undated, wins over the key
// already chosen for its model, dated `current`. An undated key wins over any
// dated one, and of two dated keys the later date wins. Two dated keys for one
// model never share a date, since they would be the same key; were they to,
// the first would stay.
const winsOver = (date: string | undefined, current: { date: string | undefined } | undefined) =>
  current === undefined ||
  (current.date !== undefined && (date === undefined || current.date < date));

// The list's entries the Hub reads, by the model each stands for: a key
// ending in `-YYYYMMDD` stands for the model without it unless the list has
// that key too, and of several such keys the latest date wins.
const entriesByModel = (list: Record<string, unknown>) => {
  const chosen = new Map<string, { date: string | undefined; fields: Record<string, unknown> }>();
  const slashed: string[] = [];
  for (const [key, fields] of Object.entries(list)) {
    if (
      !isObject(fields) ||
      !PROVIDERS.has(String(fields.litellm_provider)) ||
      !MODES.has(String(fields.mode))
    ) {
      continue;
    }
    if (key.includes('/')) {
      slashed.push(key);
      continue;
    }
    const dated = DATE_SUFFIX.exec(key);
    const model = dated?.[1] ?? key;
    const date = dated?.[2];
    if (winsOver(date, chosen.get(model))) {
      chosen.set(model, { date, fields });
    }
  }
  return { chosen, slashed };
};

const byModel = (a: { model: string }, b: { model: string }) => a.model.localeCompare(b.model);

// The models `text`, the list's JSON, prices, and those it names that the
// Hub skips, with why. Throws when the text is not a JSON object or no model
// in it fits.
export const readPriceList = (text: string): PriceList => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('The price list is not JSON.');
  }
  if (!isObject(json)) {
    throw new Error('The price list is not a JSON object.');
  }
  const { chosen, slashed } = entriesByModel(json);
  const models: ListedModel[] = [];
  const skipped: SkippedModel[] = slashed.map((model) => ({
    kind: 'unfit',
    model,
    reason: 'Its key names a provider path.',
  }));
  for (const [model, { fields }] of chosen) {
    try {
      models.push({ entries: modelEntries(model, fields), model });
    } catch (error) {
      if (!(error instanceof SkipError)) {
        throw error;
      }
      skipped.push({ kind: 'unfit', model, reason: error.message });
    }
  }
  if (models.length === 0) {
    throw new Error('The price list has no model the Hub can price.');
  }
  return { models: models.toSorted(byModel), skipped: skipped.toSorted(byModel) };
};

// How long a fetch waits for the whole answer, and how much of it it reads.
export const FETCH_TIMEOUT_MS = 30_000;
const MIB = 1024 * 1024;
const MAX_LIST_BYTES = 32 * MIB;
const MAX_REDIRECTS = 5;

const sizeText = (bytes: number) =>
  bytes % MIB === 0 ? `${String(bytes / MIB)} MiB` : `${String(bytes)} bytes`;

// A redirect may lead to HTTPS, or to plain HTTP from plain HTTP, never from
// HTTPS down to HTTP.
const followable = (url: URL, from: URL | undefined) =>
  url.protocol === 'https:' || (url.protocol === 'http:' && from?.protocol !== 'https:');

// Why an address was refused: the source itself, or one a redirect led to.
const refusedReason = ({ from, url }: { from: URL | undefined; url: URL }) => {
  if (from === undefined) {
    return 'The source is not an HTTP or HTTPS address without a user name or password.';
  }
  if (hasCredentials(url)) {
    return 'It redirected the Hub to an address that carries a user name or password.';
  }
  return from.protocol === 'https:'
    ? 'It redirected the Hub from HTTPS to an address that is not HTTPS.'
    : 'It redirected the Hub to an address that is not HTTP or HTTPS.';
};

// Fetches the list at `source` and reads it, sending no credentials and
// following redirects by hand. It waits at most `timeoutMs` for the whole
// answer, and `signal` ends it early when serve stops. Throws, saying why,
// when no answer comes in time, a redirect leaves HTTPS or goes on too long,
// its status is not 200, it is over `maxBytes`, it is not a JSON object, or no
// model in it fits.
export const fetchPriceList = async ({
  fetch,
  maxBytes = MAX_LIST_BYTES,
  signal,
  source,
  timeoutMs = FETCH_TIMEOUT_MS,
}: {
  fetch: Fetch;
  maxBytes?: number;
  signal?: AbortSignal;
  source: URL;
  timeoutMs?: number;
}): Promise<PriceList> => {
  const timeout = AbortSignal.timeout(timeoutMs);
  const ends = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  let text: string;
  try {
    const followed = await followRedirects({
      allowed: followable,
      fetch,
      init: () => ({
        headers: { Accept: 'application/json', 'User-Agent': `heimdall-hub/${HUB_VERSION}` },
        signal: ends,
      }),
      maxRedirects: MAX_REDIRECTS,
      start: source,
    });
    if (followed.kind === 'refused') {
      throw new Error(refusedReason(followed));
    }
    if (followed.kind === 'too-many') {
      throw new Error('It redirected the Hub too many times.');
    }
    const { response } = followed;
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`It answered with status ${String(response.status)}.`);
    }
    // The body can stall after the headers, so the wait covers it too.
    const ended = Promise.withResolvers<never>();
    ends.addEventListener('abort', () => ended.reject(ends.reason), { once: true });
    const body = await Promise.race([readCapped(response, maxBytes), ended.promise]);
    if (body.kind === 'over') {
      throw new Error(`The answer is more than the ${sizeText(maxBytes)} the Hub reads.`);
    }
    ({ text } = body);
  } catch (error) {
    throw new Error(`Could not fetch the price list from ${source.host}: ${describeError(error)}`, {
      cause: error,
    });
  }
  return readPriceList(text);
};
