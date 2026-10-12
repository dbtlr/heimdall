// The API list prices the Hub applies to a Session's requests (glossary:
// list-price cost). One entry per model, `validFrom` date, and prompt tier; the
// entry that applies to a request is the one with the latest `validFrom` on or
// before the request's time, so a price change is a new entry and never
// reprices an earlier request. The Hub's configuration can add or replace
// entries (price-table.ts).
//
// Prices are US dollars per million tokens. `validFrom` is a UTC day. The
// dates below are lower bounds: each is on or before the model's first
// availability, so a request is never unpriced for lack of a start date. A
// model's price changes from the date a new entry carries.
//
// A model that reprices the whole request above a prompt size has one entry
// per tier. An entry with `promptOver` applies to a request whose prompt, its
// input, cache read, and cache write tokens together, is over that many
// tokens; one without it applies to every prompt. Of the entries in force, the
// one with the highest `promptOver` the prompt exceeds applies, and among
// those the latest `validFrom`: so a dated entry replaces only its own tier.
//
// `cacheRead` is the price of tokens served from a prompt cache. For OpenAI
// models it is the cached-input price, which the Codex parser reads out of
// the input count. `cacheWrite5m` and `cacheWrite1h` are cache writes at the
// 5-minute and 1-hour TTL. OpenAI states one write price for gpt-5.6 and later
// and no TTL, so it is recorded as `cacheWrite5m`, the price of a write the
// Harness did not split; OpenAI models before gpt-5.6 have none, so those
// entries omit it and a request that wrote to a cache is unpriced.
// `contextWindow` is the model's window in tokens, which Claude Code
// transcripts do not record.
//
// Sources, read on 2026-10-12:
// - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing. Cache
//   writes are 1.25x the input price at the 5-minute TTL and 2x at the 1-hour
//   TTL; cache reads are 0.1x, except Claude Fable 5.1, Claude Mythos 5.1
//   (0.025x), Claude Opus 5.5, and Claude Sonnet 5.5 (0.05x). Claude 4.6 and
//   later models except Claude Haiku 5.5 include the 1M window at standard
//   pricing. Claude Haiku 5.5 alone is priced by prompt length ("Long context
//   pricing"). The page lists no long-context rate and no 1M window for Claude
//   Sonnet 4, Claude Sonnet 4.5, Claude Opus 4.5, or older models, which keep
//   their 200K window.
// - OpenAI: https://developers.openai.com/api/docs/pricing for prices and
//   https://developers.openai.com/api/docs/models/<model> for context windows.
//   A prompt over 272K input tokens is priced at 2x input, cache, and cache
//   write rates and 1.5x output for the whole request, for gpt-6.x, gpt-5.6.x,
//   gpt-5.5, and gpt-5.4.
//
// Left out, and so unpriced, rather than guessed: Claude models older than
// Claude Sonnet 4 and Claude Opus 4, OpenAI's specialized models such as
// gpt-5.3-codex, and any model the sources above do not list.
export type PriceEntry = {
  cacheRead?: number;
  cacheWrite1h?: number;
  cacheWrite5m?: number;
  contextWindow: number;
  input: number;
  model: string;
  output: number;
  promptOver?: number;
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
const OPENAI_LONG_WINDOW = 1_050_000;
const OPENAI_LONG_PROMPT = 272_000;

// To the micro-dollar, so a scaled price is the figure a page lists.
const rounded = (price: number) => Math.round(price * MILLION) / MILLION;

// The tier OpenAI prices above 272K prompt tokens: twice a base entry's input,
// cache read, and cache write prices, and 1.5 times its output price.
const overLongPrompt = (base: PriceEntry): PriceEntry => ({
  ...base,
  ...(base.cacheRead === undefined ? {} : { cacheRead: rounded(base.cacheRead * 2) }),
  ...(base.cacheWrite5m === undefined ? {} : { cacheWrite5m: rounded(base.cacheWrite5m * 2) }),
  input: rounded(base.input * 2),
  output: rounded(base.output * 1.5),
  promptOver: OPENAI_LONG_PROMPT,
});

// An OpenAI model with a long-prompt tier: its base entry, and the tier.
const longPromptModel = (base: PriceEntry): PriceEntry[] => [base, overLongPrompt(base)];

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
    cacheRead: 0.25,
    cacheWrite1h: 20,
    cacheWrite5m: 12.5,
    contextWindow: MILLION,
    input: 10,
    model: 'claude-mythos-5-1',
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
    cacheRead: 1,
    cacheWrite1h: 20,
    cacheWrite5m: 12.5,
    contextWindow: MILLION,
    input: 10,
    model: 'claude-mythos-5',
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
    cacheRead: 0.1,
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
  // Claude Haiku 5.5 is the one Claude model priced by prompt length.
  {
    cacheRead: 0.01,
    cacheWrite1h: 0.2,
    cacheWrite5m: 0.125,
    contextWindow: MILLION,
    input: 0.1,
    model: 'claude-haiku-5-5',
    output: 0.5,
    validFrom: '2026-10-07',
  },
  {
    cacheRead: 0.05,
    cacheWrite1h: 1,
    cacheWrite5m: 0.625,
    contextWindow: MILLION,
    input: 0.5,
    model: 'claude-haiku-5-5',
    output: 2.5,
    promptOver: 100_000,
    validFrom: '2026-10-07',
  },
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
  {
    cacheRead: 0.005,
    contextWindow: OPENAI_WINDOW,
    input: 0.05,
    model: 'gpt-5-nano',
    output: 0.4,
    validFrom: '2025-08-01',
  },
  {
    cacheRead: 0.175,
    contextWindow: OPENAI_WINDOW,
    input: 1.75,
    model: 'gpt-5.2',
    output: 14,
    validFrom: '2025-12-01',
  },
  // o3 was cut to this price on 2025-06-10, so earlier requests are unpriced.
  {
    cacheRead: 0.5,
    contextWindow: 200_000,
    input: 2,
    model: 'o3',
    output: 8,
    validFrom: '2025-06-10',
  },
  {
    cacheRead: 0.275,
    contextWindow: 200_000,
    input: 1.1,
    model: 'o4-mini',
    output: 4.4,
    validFrom: '2025-04-01',
  },
  ...longPromptModel({
    cacheRead: 0.25,
    contextWindow: OPENAI_LONG_WINDOW,
    input: 2.5,
    model: 'gpt-5.4',
    output: 15,
    validFrom: '2026-01-01',
  }),
  ...longPromptModel({
    cacheRead: 0.5,
    contextWindow: OPENAI_LONG_WINDOW,
    input: 5,
    model: 'gpt-5.5',
    output: 30,
    validFrom: '2026-01-01',
  }),
  ...longPromptModel({
    cacheRead: 0.4,
    cacheWrite5m: 5,
    contextWindow: OPENAI_LONG_WINDOW,
    input: 4,
    model: 'gpt-5.6-sol',
    output: 20,
    validFrom: '2026-01-01',
  }),
  ...longPromptModel({
    cacheRead: 0.2,
    cacheWrite5m: 2.5,
    contextWindow: OPENAI_LONG_WINDOW,
    input: 2,
    model: 'gpt-5.6-terra',
    output: 12,
    validFrom: '2026-01-01',
  }),
  ...longPromptModel({
    cacheRead: 0.02,
    cacheWrite5m: 0.25,
    contextWindow: OPENAI_LONG_WINDOW,
    input: 0.2,
    model: 'gpt-5.6-luna',
    output: 1.2,
    validFrom: '2026-01-01',
  }),
  ...longPromptModel({
    cacheRead: 0.1,
    cacheWrite5m: 2.5,
    contextWindow: OPENAI_LONG_WINDOW,
    input: 2,
    model: 'gpt-6.1-sol',
    output: 10,
    validFrom: '2026-01-01',
  }),
  ...longPromptModel({
    cacheRead: 0.2,
    cacheWrite5m: 2.5,
    contextWindow: OPENAI_LONG_WINDOW,
    input: 2,
    model: 'gpt-6-sol',
    output: 10,
    validFrom: '2026-01-01',
  }),
  ...longPromptModel({
    cacheRead: 0.01,
    cacheWrite5m: 0.125,
    contextWindow: OPENAI_LONG_WINDOW,
    input: 0.1,
    model: 'gpt-6-luna',
    output: 0.5,
    validFrom: '2026-01-01',
  }),
  ...longPromptModel({
    cacheRead: 1,
    cacheWrite5m: 12.5,
    contextWindow: OPENAI_LONG_WINDOW,
    input: 10,
    model: 'gpt-6-astra',
    output: 50,
    validFrom: '2026-01-01',
  }),
];
