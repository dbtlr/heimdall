import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SQL } from 'bun';

import { dailyFetch } from './fetched-prices.ts';
import type { PassRecord } from './hub-status.ts';
import { configArgs, configFile, hubConfig, invoke } from './testing/cli.ts';
import { migratedDatabase, startTestServer, testDatabase } from './testing/postgres.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(startTestServer, 60_000);

// A list as LiteLLM's gives it: a model no table prices, one the Hub cannot
// price, and the bundled gpt-5 with an input price a thousand times its own.
const NEW_MODEL = {
  input_cost_per_token: 2e-6,
  litellm_provider: 'openai',
  max_input_tokens: 400_000,
  mode: 'chat',
  output_cost_per_token: 1e-5,
};
const LIST = {
  'fixture-model': NEW_MODEL,
  'fixture-unfit': { ...NEW_MODEL, max_input_tokens: undefined },
};
const SUSPECT = { 'gpt-5': { ...NEW_MODEL, input_cost_per_token: 1.25e-3 } };

// A price list served nearby, counting the requests it answers.
const listServer = (answer: () => Response) => {
  let requests = 0;
  const server = Bun.serve({
    fetch: () => {
      requests += 1;
      return answer();
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  return {
    get requests() {
      return requests;
    },
    url: new URL('/prices.json', server.url).href,
    [Symbol.asyncDispose]: () => server.stop(true),
  };
};

const fetchedModels = async (sql: SQL) => {
  const rows: { model: string }[] =
    await sql`SELECT DISTINCT model FROM fetched_model_prices ORDER BY model`;
  return rows.map(({ model }) => model);
};

const configuredCount = async (sql: SQL) => {
  const [row]: { n: number }[] =
    await sql`SELECT count(*)::int AS n FROM model_prices WHERE source = 'configured'`;
  return row?.n;
};

const OVERRIDES = JSON.stringify({
  prices: [
    { contextWindow: 1000, input: 1, model: 'my-model', output: 2, validFrom: '2026-07-01' },
  ],
});

const overridesFile = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'heimdall-prices-'));
  const path = join(dir, 'prices.json');
  await writeFile(path, OVERRIDES);
  return { path, [Symbol.asyncDispose]: () => rm(dir, { force: true, recursive: true }) };
};

describe('prices update', () => {
  test('prints each model it adds entries for and how many it skipped, then that a second run finds nothing new', async () => {
    await using db = await migratedDatabase();
    await using list = listServer(() => Response.json(LIST));
    await using config = await hubConfig(db);
    const args = ['prices', 'update', ...configArgs(config), '--price-source', list.url];

    const first = await invoke(args);
    const second = await invoke(args);

    expect(first.stdout).toBe(
      'Added fetched prices for fixture-model from 2020-01-01: every prompt.\nSkipped 1 model.\n',
    );
    expect(first.code).toBe(0);
    expect(second.stdout).toBe('Prices are up to date.\nSkipped 1 model.\n');
    expect(second.code).toBe(0);
    expect(await fetchedModels(db.sql)).toEqual(['fixture-model']);
  });

  test('loads the bundled and configured prices first, from the overrides it names', async () => {
    await using db = await testDatabase();
    await using list = listServer(() => Response.json(LIST));
    await using overrides = await overridesFile();
    await using config = await hubConfig(db);

    const { code } = await invoke([
      'prices',
      'update',
      ...configArgs(config),
      '--price-source',
      list.url,
      '--price-overrides',
      overrides.path,
    ]);

    expect(code).toBe(0);
    expect(await configuredCount(db.sql)).toBe(1);
  });

  test('warns of a model skipped as a possible unit error', async () => {
    await using db = await migratedDatabase();
    await using list = listServer(() => Response.json({ ...LIST, ...SUSPECT }));
    await using config = await hubConfig(db);

    const { code, stderr, stdout } = await invoke([
      'prices',
      'update',
      ...configArgs(config),
      '--price-source',
      list.url,
    ]);

    expect(stderr).toContain('Skipped gpt-5, a possible unit error: Its input price');
    expect(stdout).toEndWith('Skipped 2 models.\n');
    expect(code).toBe(0);
  });

  test('with the source off, loads the bundled and configured prices, says fetching is off, and exits 0', async () => {
    await using db = await migratedDatabase();
    await using overrides = await overridesFile();
    await using config = await hubConfig(db);

    const { code, stdout } = await invoke([
      'prices',
      'update',
      ...configArgs(config),
      '--price-overrides',
      overrides.path,
    ]);

    expect(stdout).toBe(
      'Fetching prices is off, so only the bundled and configured prices were loaded.\n',
    );
    expect(code).toBe(0);
    expect(await configuredCount(db.sql)).toBe(1);
  });

  test('reads the source from the configuration file', async () => {
    await using db = await migratedDatabase();
    await using list = listServer(() => Response.json(LIST));
    await using config = await configFile([
      '[database]',
      `url = "${db.url.href}"`,
      '[prices]',
      `source = "${list.url}"`,
    ]);

    const { code } = await invoke(['prices', 'update', ...configArgs(config)], {
      configuredPriceSource: true,
    });

    expect(code).toBe(0);
    expect(list.requests).toBe(1);
  });

  test.each([
    ['a status other than 200', () => new Response('{}', { status: 503 }), 'status 503'],
    ['an answer that is not a JSON object', () => new Response('[]'), 'not a JSON object'],
    ['a list in which no model fits', () => Response.json({ x: NEW_MODEL.mode }), 'no model'],
  ])(
    'on %s, says why and exits 1, with the bundled and configured prices loaded',
    async (_name, answer, why) => {
      await using db = await migratedDatabase();
      await using list = listServer(answer);
      await using overrides = await overridesFile();
      await using config = await hubConfig(db);

      const { code, stderr } = await invoke([
        'prices',
        'update',
        ...configArgs(config),
        '--price-source',
        list.url,
        '--price-overrides',
        overrides.path,
      ]);

      expect(stderr).toContain(why);
      expect(code).toBe(1);
      expect(await configuredCount(db.sql)).toBe(1);
      expect(await fetchedModels(db.sql)).toEqual([]);
    },
  );

  test('refuses a source that is neither an http or https URL nor off', async () => {
    const { code, stderr } = await invoke([
      'prices',
      'update',
      '--database',
      'postgres://127.0.0.1:1/none',
      '--price-source',
      'ftp://example.test/prices.json',
    ]);

    expect(stderr).toContain('off');
    expect(code).toBe(2);
  });
});

// The Hub's status row, as serve writes it.
const pricesRun = async (sql: SQL) => {
  const [row]: { last_runs: Record<string, PassRecord> }[] =
    await sql`SELECT last_runs FROM hub_status`;
  return row?.last_runs.prices;
};

// Polls `check` until it holds, for at most a few seconds.
const eventually = async (check: () => Promise<boolean>) => {
  for (let tries = 0; tries < 200; tries += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls until it holds.
    if (await check()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polls until it holds.
    await Bun.sleep(20);
  }
};

describe('serve', () => {
  test('fetches as it starts, logs each model it adds and each possible unit error, and keeps the entries across a restart', async () => {
    await using db = await migratedDatabase();
    await using list = listServer(() => Response.json({ ...LIST, ...SUSPECT }));
    await using config = await hubConfig(db);
    const args = ['serve', ...configArgs(config)];

    const { code, stdout } = await invoke(args, {
      env: { HEIMDALL_PRICE_SOURCE: list.url },
      whileServing: () =>
        eventually(async () => (await pricesRun(db.sql))?.succeeded_at !== undefined),
    });
    await invoke(args, {
      whileServing: () => eventually(async () => (await pricesRun(db.sql))?.off === true),
    });

    expect(code).toBe(130);
    expect(stdout).toMatch(
      /Z Added fetched prices for fixture-model from 2020-01-01: every prompt\.\n/u,
    );
    expect(stdout).toMatch(/Z warning: Skipped gpt-5, a possible unit error: Its input price, /u);
    expect(stdout).not.toContain('fixture-unfit');
    expect(await fetchedModels(db.sql)).toEqual(['fixture-model']);
  });

  test('warns when a fetch fails, keeps serving, and records the prices pass failing', async () => {
    await using db = await migratedDatabase();
    await using list = listServer(() => new Response('gone', { status: 404 }));
    await using config = await hubConfig(db);
    let health = 0;

    const { code, stdout } = await invoke(['serve', ...configArgs(config)], {
      env: { HEIMDALL_PRICE_SOURCE: list.url },
      whileServing: async (hub) => {
        await eventually(async () => (await pricesRun(db.sql))?.failing_since !== undefined);
        health = (await fetch(new URL('api/health', hub))).status;
      },
    });

    expect(stdout).toMatch(/Z warning: Could not update the fetched prices: .*status 404/u);
    expect(health).toBe(200);
    expect(code).toBe(130);
    expect(await fetchedModels(db.sql)).toEqual([]);
  });

  test('with the source off, records the prices pass as off and never fetches', async () => {
    await using db = await migratedDatabase();
    await using list = listServer(() => Response.json(LIST));
    await using config = await configFile([
      'host = "127.0.0.1"',
      'port = 0',
      '[database]',
      `url = "${db.url.href}"`,
      '[prices]',
      'source = "off"',
    ]);

    await invoke(['serve', ...configArgs(config)], {
      configuredPriceSource: true,
      whileServing: () => eventually(async () => (await pricesRun(db.sql)) !== undefined),
    });

    const run = await pricesRun(db.sql);
    expect(run).toMatchObject({ off: true });
    expect(run?.started_at).toBeUndefined();
    expect(list.requests).toBe(0);
  });
});

describe('the daily fetch', () => {
  const DAY = 86_400_000;

  test('fetches when the process has had no successful fetch in the last day, and retries a failure on the next run', async () => {
    const clock = { now: 0 };
    let fetches = 0;
    let fails = false;
    const run = dailyFetch({
      fetch: async () => {
        fetches += 1;
        if (fails) {
          throw new Error('unreachable');
        }
      },
      now: () => clock.now,
    });

    await run();
    clock.now = DAY - 1;
    await run();
    expect(fetches).toBe(1);

    clock.now = DAY;
    fails = true;
    let failure: unknown;
    try {
      await run();
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(new Error('unreachable'));
    clock.now = DAY + 3_600_000;
    fails = false;
    await run();
    expect(fetches).toBe(3);
    clock.now = 2 * DAY;
    await run();
    expect(fetches).toBe(3);
  });

  test('is due when the clock has gone back since its last success', async () => {
    const clock = { now: 10 * DAY };
    let fetches = 0;
    const run = dailyFetch({
      fetch: async () => {
        fetches += 1;
      },
      now: () => clock.now,
    });

    await run();
    clock.now -= 1;
    await run();

    expect(fetches).toBe(2);
  });
});
