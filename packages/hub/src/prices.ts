// The API list prices the Hub applies to a Session's requests (glossary:
// list-price cost). One entry per model and `validFrom` date; the entry that
// applies to a request is the one with the latest `validFrom` on or before the
// request's time, so a price change is a new entry and never reprices an
// earlier request. The Hub's configuration can add or replace entries
// (price-table.ts).
//
// Prices are US dollars per million tokens. `validFrom` is a UTC day. The
// dates below are lower bounds: each is on or before the model's first
// availability, so a request is never unpriced for lack of a start date. A
// model's price changes from the date a new entry carries.
//
// `cacheRead` is the price of tokens served from a prompt cache. For OpenAI
// models it is the cached-input price, which the Codex parser reads out of
// the input count. `cacheWrite5m` and `cacheWrite1h` are Anthropic's cache
// writes at the 5-minute and 1-hour TTL; OpenAI has no write price, so those
// entries omit them and a request that wrote to a cache is unpriced.
// `contextWindow` is the model's window in tokens, which Claude Code
// transcripts do not record.
//
// Sources, read on 2026-10-06:
// - Anthropic: the Claude API model and pricing reference
//   (https://platform.claude.com/docs/en/about-claude/pricing). Cache writes
//   are 1.25x the input price at the 5-minute TTL and 2x at the 1-hour TTL;
//   cache reads are 0.1x, except Claude Fable 5.1 (0.025x) and Claude Opus 5.5
//   (0.05x).
// - OpenAI: the API pricing page (https://platform.openai.com/docs/pricing).
//
// Left out, and so unpriced, rather than guessed: Claude Haiku 5.5 (its price
// depends on the prompt's size, which this table does not model), Claude
// Mythos, Claude models older than Claude Sonnet 4 and Claude Opus 4, and
// OpenAI models whose price this table does not hold with confidence
// (gpt-5-nano, gpt-5.2 and later, the o-series, and gpt-6.x).
export type PriceEntry = {
  cacheRead?: number;
  cacheWrite1h?: number;
  cacheWrite5m?: number;
  contextWindow: number;
  input: number;
  model: string;
  output: number;
  validFrom: string;
};

const OPUS_4_PRICES = {
  cacheRead: 0.5,
  cacheWrite1h: 10,
  cacheWrite5m: 6.25,
  input: 5,
  output: 25,
} as const;

const SONNET_PRICES = {
  cacheRead: 0.3,
  cacheWrite1h: 6,
  cacheWrite5m: 3.75,
  input: 3,
  output: 15,
} as const;

const OPENAI_FLAGSHIP_PRICES = { cacheRead: 0.125, input: 1.25, output: 10 } as const;
const OPENAI_MINI_PRICES = { cacheRead: 0.025, input: 0.25, output: 2 } as const;

const MILLION = 1_000_000;
const OPENAI_WINDOW = 400_000;

export const BUNDLED_PRICES: readonly PriceEntry[] = [
  // Anthropic
  {
    cacheRead: 0.25,
    cacheWrite1h: 20,
    cacheWrite5m: 12.5,
    contextWindow: MILLION,
    input: 10,
    model: 'claude-fable-5-1',
    output: 50,
    validFrom: '2026-01-01',
  },
  {
    cacheRead: 1,
    cacheWrite1h: 20,
    cacheWrite5m: 12.5,
    contextWindow: MILLION,
    input: 10,
    model: 'claude-fable-5',
    output: 50,
    validFrom: '2026-01-01',
  },
  {
    cacheRead: 0.2,
    cacheWrite1h: 8,
    cacheWrite5m: 5,
    contextWindow: MILLION,
    input: 4,
    model: 'claude-opus-5-5',
    output: 20,
    validFrom: '2026-01-01',
  },
  { ...OPUS_4_PRICES, contextWindow: MILLION, model: 'claude-opus-5', validFrom: '2026-01-01' },
  { ...OPUS_4_PRICES, contextWindow: MILLION, model: 'claude-opus-4-8', validFrom: '2025-01-01' },
  { ...OPUS_4_PRICES, contextWindow: MILLION, model: 'claude-opus-4-7', validFrom: '2025-01-01' },
  { ...OPUS_4_PRICES, contextWindow: MILLION, model: 'claude-opus-4-6', validFrom: '2025-01-01' },
  { ...OPUS_4_PRICES, contextWindow: 200_000, model: 'claude-opus-4-5', validFrom: '2025-01-01' },
  {
    cacheRead: 1.5,
    cacheWrite1h: 30,
    cacheWrite5m: 18.75,
    contextWindow: 200_000,
    input: 15,
    model: 'claude-opus-4-1',
    output: 75,
    validFrom: '2025-01-01',
  },
  {
    cacheRead: 1.5,
    cacheWrite1h: 30,
    cacheWrite5m: 18.75,
    contextWindow: 200_000,
    input: 15,
    model: 'claude-opus-4',
    output: 75,
    validFrom: '2025-01-01',
  },
  {
    cacheRead: 0.2,
    cacheWrite1h: 4,
    cacheWrite5m: 2.5,
    contextWindow: MILLION,
    input: 2,
    model: 'claude-sonnet-5-5',
    output: 10,
    validFrom: '2026-01-01',
  },
  {
    cacheRead: 0.2,
    cacheWrite1h: 4,
    cacheWrite5m: 2.5,
    contextWindow: MILLION,
    input: 2,
    model: 'claude-sonnet-5',
    output: 10,
    validFrom: '2026-01-01',
  },
  { ...SONNET_PRICES, contextWindow: MILLION, model: 'claude-sonnet-4-6', validFrom: '2025-01-01' },
  {
    ...SONNET_PRICES,
    contextWindow: 200_000,
    model: 'claude-sonnet-4-5',
    validFrom: '2025-01-01',
  },
  { ...SONNET_PRICES, contextWindow: 200_000, model: 'claude-sonnet-4', validFrom: '2025-01-01' },
  {
    cacheRead: 0.1,
    cacheWrite1h: 2,
    cacheWrite5m: 1.25,
    contextWindow: 200_000,
    input: 1,
    model: 'claude-haiku-4-5',
    output: 5,
    validFrom: '2025-01-01',
  },
  // OpenAI, as Codex runs them
  {
    ...OPENAI_FLAGSHIP_PRICES,
    contextWindow: OPENAI_WINDOW,
    model: 'gpt-5',
    validFrom: '2025-08-01',
  },
  {
    ...OPENAI_FLAGSHIP_PRICES,
    contextWindow: OPENAI_WINDOW,
    model: 'gpt-5-codex',
    validFrom: '2025-08-01',
  },
  {
    ...OPENAI_FLAGSHIP_PRICES,
    contextWindow: OPENAI_WINDOW,
    model: 'gpt-5.1',
    validFrom: '2025-11-01',
  },
  {
    ...OPENAI_FLAGSHIP_PRICES,
    contextWindow: OPENAI_WINDOW,
    model: 'gpt-5.1-codex',
    validFrom: '2025-11-01',
  },
  {
    ...OPENAI_MINI_PRICES,
    contextWindow: OPENAI_WINDOW,
    model: 'gpt-5-mini',
    validFrom: '2025-08-01',
  },
  {
    ...OPENAI_MINI_PRICES,
    contextWindow: OPENAI_WINDOW,
    model: 'gpt-5.1-codex-mini',
    validFrom: '2025-11-01',
  },
];
