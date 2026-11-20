import { describe, expect, test } from 'bun:test';

import type { Fetch } from './outbound-http.ts';
import { fetchPriceList, parsePriceSource, readPriceList } from './price-list.ts';

// An Anthropic entry as LiteLLM's list gives Claude Haiku 5.5: per-token
// prices, a 1-hour write, a tier over 100k prompt tokens, and fields the Hub
// does not read.
const HAIKU = {
  cache_creation_input_token_cost: 1.25e-7,
  cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
  cache_creation_input_token_cost_above_1hr: 2e-7,
  cache_creation_input_token_cost_above_1hr_above_100k_tokens: 1e-6,
  cache_read_input_token_cost: 1e-8,
  cache_read_input_token_cost_above_100k_tokens: 5e-8,
  input_cost_per_token: 1e-7,
  input_cost_per_token_above_100k_tokens: 5e-7,
  litellm_provider: 'anthropic',
  max_input_tokens: 1_000_000,
  mode: 'chat',
  output_cost_per_token: 5e-7,
  output_cost_per_token_above_100k_tokens: 2.5e-6,
  search_context_cost_per_query: { search_context_size_high: 0.01 },
};

// An OpenAI entry as the list gives gpt-6.1-sol, with batch, flex, priority,
// and 12-hour prices the Hub ignores.
const SOL = {
  cache_creation_input_token_cost: 2.5e-6,
  cache_creation_input_token_cost_above_12hr: 9e-6,
  cache_creation_input_token_cost_above_272k_tokens: 5e-6,
  cache_read_input_token_cost: 1e-7,
  cache_read_input_token_cost_above_272k_tokens: 2e-7,
  input_cost_per_token: 2e-6,
  input_cost_per_token_above_272k_tokens: 4e-6,
  input_cost_per_token_above_272k_tokens_priority: 8e-6,
  input_cost_per_token_batches: 1e-6,
  input_cost_per_token_flex: 1e-6,
  litellm_provider: 'openai',
  max_input_tokens: 922_000,
  mode: 'responses',
  output_cost_per_token: 1e-5,
  output_cost_per_token_above_272k_tokens: 1.5e-5,
};

const listOf = (entries: Record<string, unknown>) => JSON.stringify(entries);

describe('reading the price list', () => {
  test('reads each tier at dollars per million tokens, and the context window', () => {
    expect(readPriceList(listOf({ 'claude-haiku-5-5': HAIKU }))).toEqual({
      models: [
        {
          entries: [
            {
              cacheRead: 0.01,
              cacheWrite1h: 0.2,
              cacheWrite5m: 0.125,
              contextWindow: 1_000_000,
              input: 0.1,
              model: 'claude-haiku-5-5',
              output: 0.5,
            },
            {
              cacheRead: 0.05,
              cacheWrite1h: 1,
              cacheWrite5m: 0.625,
              contextWindow: 1_000_000,
              input: 0.5,
              model: 'claude-haiku-5-5',
              output: 2.5,
              promptOver: 100_000,
            },
          ],
          model: 'claude-haiku-5-5',
        },
      ],
      skipped: [],
    });
  });

  test('ignores batch, flex, priority, and 12-hour prices, and leaves a tier without a cache price without it', () => {
    const [sol] = readPriceList(listOf({ 'gpt-6.1-sol': SOL })).models;

    expect(sol?.entries).toEqual([
      {
        cacheRead: 0.1,
        cacheWrite5m: 2.5,
        contextWindow: 922_000,
        input: 2,
        model: 'gpt-6.1-sol',
        output: 10,
      },
      {
        cacheRead: 0.2,
        cacheWrite5m: 5,
        contextWindow: 922_000,
        input: 4,
        model: 'gpt-6.1-sol',
        output: 15,
        promptOver: 272_000,
      },
    ]);
  });

  test('rounds each price to a millionth of a dollar per million tokens', () => {
    const [model] = readPriceList(
      listOf({ m: { ...SOL, input_cost_per_token: 3e-6, output_cost_per_token: 1.234_567_89e-6 } }),
    ).models;

    expect([model?.entries[0]?.input, model?.entries[0]?.output]).toEqual([3, 1.234_568]);
  });

  test('reads only Anthropic and OpenAI models in chat and responses modes', () => {
    const { models, skipped } = readPriceList(
      listOf({
        'a-chat': HAIKU,
        'b-responses': SOL,
        'c-embedding': { ...SOL, mode: 'embedding' },
        'd-other-provider': { ...HAIKU, litellm_provider: 'bedrock' },
        'e-not-an-entry': 'text',
        sample_spec: { litellm_provider: 'one of the providers', mode: 'one of the modes' },
      }),
    );

    expect(models.map((m) => m.model)).toEqual(['a-chat', 'b-responses']);
    expect(skipped).toEqual([]);
  });

  test('a dated key stands for the model without its date, and the latest date wins', () => {
    const { models } = readPriceList(
      listOf({
        'claude-sonnet-4-5-20250929': { ...HAIKU, input_cost_per_token: 3e-6 },
        'claude-sonnet-4-5-20251201': { ...HAIKU, input_cost_per_token: 4e-6 },
      }),
    );

    expect(models.map((m) => [m.model, m.entries[0]?.input])).toEqual([['claude-sonnet-4-5', 4]]);
  });

  test('an undated key wins over dated keys for the same model', () => {
    const { models } = readPriceList(
      listOf({
        'claude-sonnet-4-5': { ...HAIKU, input_cost_per_token: 3e-6 },
        'claude-sonnet-4-5-20251201': { ...HAIKU, input_cost_per_token: 4e-6 },
      }),
    );

    expect(models.map((m) => [m.model, m.entries[0]?.input])).toEqual([['claude-sonnet-4-5', 3]]);
  });

  test.each([
    ['the undated key first', ['claude-sonnet-4-5', 'claude-sonnet-4-5-99999999']],
    ['the dated key first', ['claude-sonnet-4-5-99999999', 'claude-sonnet-4-5']],
  ])('an undated key wins over a key dated 99999999, with %s', (_name, keys) => {
    const prices: Record<string, number> = {
      'claude-sonnet-4-5': 3e-6,
      'claude-sonnet-4-5-99999999': 4e-6,
    };
    const { models } = readPriceList(
      listOf(
        Object.fromEntries(
          keys.map((key) => [key, { ...HAIKU, input_cost_per_token: prices[key] }]),
        ),
      ),
    );

    expect(models.map((m) => [m.model, m.entries[0]?.input])).toEqual([['claude-sonnet-4-5', 3]]);
  });

  test('the latest of several dated keys wins, whatever their order', () => {
    const { models } = readPriceList(
      listOf({
        'claude-sonnet-4-5-20250929': { ...HAIKU, input_cost_per_token: 3e-6 },
        'claude-sonnet-4-5-20251201': { ...HAIKU, input_cost_per_token: 4e-6 },
      }),
    );

    expect(models.map((m) => [m.model, m.entries[0]?.input])).toEqual([['claude-sonnet-4-5', 4]]);
  });

  test('a key with a dashed date is a model of its own', () => {
    const { models } = readPriceList(listOf({ o3: SOL, 'o3-2025-04-16': SOL }));

    expect(models.map((m) => m.model)).toEqual(['o3', 'o3-2025-04-16']);
  });
});

describe('a model the Hub cannot price is skipped, with the reason', () => {
  const { input_cost_per_token: _input, ...noInput } = SOL;
  const { output_cost_per_token: _output, ...noOutput } = SOL;
  const { max_input_tokens: _window, ...noWindow } = SOL;
  const { output_cost_per_token_above_272k_tokens: _tierOutput, ...tierWithoutOutput } = SOL;

  test.each([
    ['a key that holds a /', 'openai/container', SOL, 'provider path'],
    ['no input price', 'no-input', noInput, 'input price'],
    ['no output price', 'no-output', noOutput, 'output price'],
    ['no max_input_tokens', 'no-window', noWindow, 'max_input_tokens'],
    ['a tier without an output price', 'half-tier', tierWithoutOutput, '272,000'],
    [
      'input and output prices both 0',
      'free',
      { ...SOL, input_cost_per_token: 0, output_cost_per_token: 0 },
      'both 0',
    ],
    ['the reserved model unknown', 'unknown', SOL, 'reserved'],
    ['a negative price', 'negative', { ...SOL, cache_read_input_token_cost: -1e-7 }, 'cacheRead'],
    [
      'a price that is not a number',
      'text-price',
      { ...SOL, input_cost_per_token: '2e-6' },
      'input',
    ],
    [
      'a window that is not a whole number',
      'odd-window',
      { ...SOL, max_input_tokens: 1.5 },
      'contextWindow',
    ],
  ])('%s', (_name, key, entry, reason) => {
    const { models, skipped } = readPriceList(listOf({ fine: SOL, [key]: entry }));

    expect(models.map((m) => m.model)).toEqual(['fine']);
    expect(skipped).toEqual([
      { kind: 'unfit', model: key, reason: expect.stringContaining(reason) },
    ]);
  });
});

describe('a list the Hub cannot read fails', () => {
  test.each([
    ['text that is not JSON', 'not json', 'not JSON'],
    ['a JSON array', '[]', 'not a JSON object'],
    ['JSON null', 'null', 'not a JSON object'],
    [
      'a list with no model that fits',
      listOf({ 'no-window': { ...SOL, max_input_tokens: 0 } }),
      'no model',
    ],
    [
      'a list with no Anthropic or OpenAI model',
      listOf({ other: { ...SOL, litellm_provider: 'x' } }),
      'no model',
    ],
  ])('%s', (_name, text, message) => {
    expect(() => readPriceList(text)).toThrow(message);
  });
});

// A local server that answers every request with `answer`, for as long as the
// test runs.
const serving = (answer: (request: Request) => Response | Promise<Response>) => {
  const server = Bun.serve({ fetch: answer, hostname: '127.0.0.1', port: 0 });
  return {
    url: new URL('/prices.json', server.url),
    [Symbol.asyncDispose]: () => server.stop(true),
  };
};

// What `promise` fails with, or undefined when it does not.
const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe('fetching the price list', () => {
  test('reads the list a source serves, with no Authorization or Cookie header', async () => {
    const seen: Request[] = [];
    await using source = serving((request) => {
      seen.push(request);
      return new Response(listOf({ 'gpt-6.1-sol': SOL }));
    });

    const list = await fetchPriceList({ fetch, source: source.url });

    expect(list.models.map((m) => m.model)).toEqual(['gpt-6.1-sol']);
    expect(
      seen.map((r) => [r.method, r.headers.get('authorization'), r.headers.get('cookie')]),
    ).toEqual([['GET', null, null]]);
  });

  test('follows a redirect from HTTPS to HTTPS, and refuses one to plain HTTP before contacting it', async () => {
    const sent: string[] = [];
    const routes: Record<string, () => Response> = {
      'https://downgrade.example/prices.json': () =>
        Response.redirect('http://prices.example/prices.json', 302),
      'https://moved.example/prices.json': () =>
        Response.redirect('https://prices.example/prices.json', 301),
      'https://prices.example/prices.json': () => new Response(listOf({ 'gpt-6.1-sol': SOL })),
    };
    const stub: Fetch = async (url, init) => {
      sent.push(url.href);
      expect(init.redirect).toBe('manual');
      const route = routes[url.href];
      if (route === undefined) {
        throw new Error(`Unexpected request to ${url.href}`);
      }
      return route();
    };

    const moved = await fetchPriceList({
      fetch: stub,
      source: new URL('https://moved.example/prices.json'),
    });
    const downgraded = await failureOf(
      fetchPriceList({ fetch: stub, source: new URL('https://downgrade.example/prices.json') }),
    );

    expect(moved.models.map((m) => m.model)).toEqual(['gpt-6.1-sol']);
    expect(downgraded).toBe(
      'Could not fetch the price list from downgrade.example: It redirected the Hub from HTTPS to an address that is not HTTPS.',
    );
    expect(sent).not.toContain('http://prices.example/prices.json');
  });

  test('refuses a redirect to an address with a user name or password before contacting it', async () => {
    const sent: string[] = [];
    const stub: Fetch = async (url) => {
      sent.push(url.href);
      return url.href === 'https://source.example/prices.json'
        ? Response.redirect('https://user:secret@prices.example/prices.json', 302)
        : new Response(listOf({ 'gpt-6.1-sol': SOL }));
    };

    const failure = await failureOf(
      fetchPriceList({ fetch: stub, source: new URL('https://source.example/prices.json') }),
    );

    expect(failure).toBe(
      'Could not fetch the price list from source.example: It redirected the Hub to an address that carries a user name or password.',
    );
    expect(sent).toEqual(['https://source.example/prices.json']);
  });

  test('follows only redirect statuses: a 300 or 304 with an address fails as its status', async () => {
    for (const status of [300, 304]) {
      const sent: string[] = [];
      const stub: Fetch = async (url) => {
        sent.push(url.href);
        return url.href === 'https://source.example/prices.json'
          ? new Response(null, {
              headers: { location: 'https://prices.example/prices.json' },
              status,
            })
          : new Response(listOf({ 'gpt-6.1-sol': SOL }));
      };

      // oxlint-disable-next-line no-await-in-loop -- one status at a time.
      const failure = await failureOf(
        fetchPriceList({ fetch: stub, source: new URL('https://source.example/prices.json') }),
      );

      expect(failure).toBe(
        `Could not fetch the price list from source.example: It answered with status ${String(status)}.`,
      );
      expect(sent).toEqual(['https://source.example/prices.json']);
    }
  });

  test('follows a redirect from a plain HTTP source to another', async () => {
    await using target = serving(() => new Response(listOf({ 'gpt-6.1-sol': SOL })));
    await using source = serving(() => Response.redirect(target.url.href, 302));

    const list = await fetchPriceList({ fetch, source: source.url });

    expect(list.models.map((m) => m.model)).toEqual(['gpt-6.1-sol']);
  });

  test('fails on a redirect loop after a few hops', async () => {
    let requests = 0;
    await using source = serving((request) => {
      requests += 1;
      return Response.redirect(request.url, 302);
    });

    expect(await failureOf(fetchPriceList({ fetch, source: source.url }))).toContain(
      'too many times',
    );
    expect(requests).toBe(6);
  });

  test('fails on a status other than 200, and names it', async () => {
    await using source = serving(() => new Response(listOf({ m: SOL }), { status: 404 }));

    expect(await failureOf(fetchPriceList({ fetch, source: source.url }))).toContain('404');
  });

  test('fails on an answer it cannot read', async () => {
    await using source = serving(() => new Response('[1, 2]'));

    expect(await failureOf(fetchPriceList({ fetch, source: source.url }))).toContain(
      'not a JSON object',
    );
  });

  test('fails when no answer comes', async () => {
    const source = serving(() => new Response('{}'));
    await source[Symbol.asyncDispose]();

    expect(await failureOf(fetchPriceList({ fetch, source: source.url }))).toContain(
      'Could not fetch the price list',
    );
  });

  test('fails on an answer over the limit', async () => {
    await using source = serving(() => new Response(listOf({ m: SOL, pad: 'x'.repeat(4096) })));

    expect(
      await failureOf(fetchPriceList({ fetch, maxBytes: 1024, source: source.url })),
    ).toContain('more than');
  });

  test('reads an answer of exactly the limit, and refuses one a byte over it', async () => {
    const body = listOf({ m: SOL });
    const bytes = Buffer.byteLength(body);
    await using source = serving(() => new Response(body));

    const atLimit = await fetchPriceList({ fetch, maxBytes: bytes, source: source.url });
    const overLimit = await failureOf(
      fetchPriceList({ fetch, maxBytes: bytes - 1, source: source.url }),
    );

    expect(atLimit.models.map((m) => m.model)).toEqual(['m']);
    expect(overLimit).toContain(`more than the ${String(bytes - 1)} bytes`);
  });

  test('fails when the answer takes longer than the timeout, even after its headers', async () => {
    await using slow = serving(async () => {
      await Bun.sleep(1000);
      return new Response(listOf({ m: SOL }));
    });
    await using stalled = serving(
      () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode('{"m":'));
            },
          }),
        ),
    );

    for (const source of [slow, stalled]) {
      const started = performance.now();
      // oxlint-disable-next-line no-await-in-loop -- one source at a time.
      const failure = await failureOf(
        fetchPriceList({ fetch, source: source.url, timeoutMs: 100 }),
      );
      expect(failure).toContain('Could not fetch the price list');
      expect(performance.now() - started).toBeLessThan(900);
    }
  });
});

describe('the price source', () => {
  test('is off, an HTTPS URL, or an HTTP one', () => {
    expect(parsePriceSource('off')).toEqual({ kind: 'off' });
    expect(parsePriceSource('https://prices.example/list.json')).toEqual({
      kind: 'list',
      url: new URL('https://prices.example/list.json'),
    });
    expect(parsePriceSource('http://127.0.0.1:8080/list.json')?.kind).toBe('list');
    expect(parsePriceSource('ftp://prices.example/list.json')).toBeUndefined();
  });

  test('refuses a URL with a user name or password, since a fetch sends no credentials', () => {
    expect(parsePriceSource('https://user:secret@prices.example/list.json')).toBeUndefined();
    expect(parsePriceSource('https://user@prices.example/list.json')).toBeUndefined();
  });
});
