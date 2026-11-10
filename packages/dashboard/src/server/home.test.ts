import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, push, report, startHub, storeToken, timeline, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';
import type { SQL } from 'bun';

import { readHome } from './home.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const { addCondition } = timeline(NOW);

const check = (service: string, state: string) => ({
  check: 'supervisor',
  detail: 'Observed supervisor or health state',
  service,
  since: NOW - HOUR,
  state,
});

// One Report from `system`, received at NOW, with a sample at each of `times`
// and the Services `up` and `down` recorded and checked.
const hear = async (
  h: Hub,
  system: string,
  { down = [], times = [NOW], up = [] }: { down?: string[]; times?: number[]; up?: string[] } = {},
) => {
  h.clock.now = NOW;
  const names = [...up, ...down];
  const response = await push(
    h.hub,
    {
      ...report(system, times),
      checks: {
        services: [
          ...up.map((name) => check(name, 'up')),
          ...down.map((name) => check(name, 'stopped')),
        ],
      },
      records: {
        records: names.map((name) => ({
          kind: 'service',
          name,
          record: { name, supervisor: 'systemd', unit: `${name}.service` },
        })),
        unreadable: [],
      },
    },
    { token: tokenOf(system) },
  );
  expect(response.status).toBe(200);
};

// A System's token, named as startHub names those of server-1 and laptop-1,
// the two Systems it pairs.
const tokenOf = (system: string) => `${system.split('-')[0] ?? system}-token`;

const pair = (h: Hub, system: string) =>
  storeToken(h.db.sql, { pairedAt: NOW, system, token: tokenOf(system) });

const home = (h: Hub) => readHome(h.db.sql, { now: NOW, unpaired: false });

const warning = (h: Hub, system: string, raisedAt: number) =>
  addCondition(h.db.sql, { kind: 'high_memory', level: 'warning', raisedAt, system });

// The SQL handle, counting each statement it or a transaction it opens is
// given. A fragment nested in a statement counts too, which a comparison of
// counts does not mind.
const counting = (sql: SQL) => {
  let statements = 0;
  const wrap = (target: SQL): SQL =>
    new Proxy(target, {
      apply: (fn, _this, args: unknown[]) => {
        const [first] = args;
        if (Array.isArray(first) && 'raw' in first) {
          statements += 1;
        }
        return Reflect.apply(fn, target, args);
      },
      get: (held, property) => {
        const value: unknown = Reflect.get(held, property, held);
        if (property === 'begin' && typeof value === 'function') {
          return (...args: unknown[]) => {
            const work = args.at(-1) as (tx: SQL) => unknown;
            return Reflect.apply(value, held, [...args.slice(0, -1), (tx: SQL) => work(wrap(tx))]);
          };
        }
        return typeof value === 'function' ? value.bind(held) : value;
      },
    });
  return { sql: wrap(sql), statements: () => statements };
};

describe('readHome', () => {
  test("draws each paired System's tile with a day of CPU, its gaps, and its Services up, and a System that never reported, which has no row, with none", async () => {
    await using h = await startHub();
    const times = [NOW - 2 * HOUR, NOW - 2 * HOUR + 15_000, NOW - 30 * MINUTE];
    await hear(h, 'server-1', { down: ['api'], times, up: ['web', 'db'] });

    const read = await home(h);
    const [laptop, server] = read.lanes;

    expect(read.from).toBe(NOW - DAY);
    expect(server?.name).toBe('server-1');
    expect(server?.services).toEqual({ total: 3, up: 2 });
    expect(server?.cpu.map(({ t }) => t)).toEqual([NOW - 2 * HOUR, NOW - 30 * MINUTE]);
    expect(server?.gaps[0]).toEqual({ from: NOW - DAY, to: NOW - 2 * HOUR });
    expect(laptop).toMatchObject({
      cpu: [],
      gaps: [{ from: NOW - DAY, to: NOW }],
      lastSeenAt: undefined,
      name: 'laptop-1',
      services: { total: 0, up: 0 },
      status: 'never_seen',
    });
  });

  test('counts a Service with a Service restarted note as up, and an asleep System by the checks it last held', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { up: ['web', 'db'] });
    await hear(h, 'laptop-1', { up: ['web', 'db'] });
    await addCondition(h.db.sql, {
      kind: 'service_restarted',
      level: 'note',
      raisedAt: -60,
      subject: 'web',
      system: 'server-1',
    });
    await h.db.sql`
      UPDATE systems SET sleeps = true, last_seen_at = ${new Date(NOW - 3 * HOUR)}
      WHERE name = 'laptop-1'
    `;

    const { lanes } = await home(h);
    const [laptop, server] = ['laptop-1', 'server-1'].map((name) =>
      lanes.find((lane) => lane.name === name),
    );

    expect(server?.services).toEqual({ total: 2, up: 2 });
    expect(laptop?.status).toBe('asleep');
    expect(laptop?.services).toEqual({ total: 2, up: 2 });
  });

  test('counts a quiet System that does not sleep as having no Service up', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { up: ['web'] });
    await h.db.sql`
      UPDATE systems SET sleeps = false, last_seen_at = ${new Date(NOW - 3 * HOUR)}
      WHERE name = 'server-1'
    `;

    const server = (await home(h)).lanes.find(({ name }) => name === 'server-1');

    expect(server?.services).toEqual({ total: 1, up: 0 });
  });

  test('reads the chart and memory holders behind a High memory lead, the newest of the worst', async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { times: [NOW - HOUR, NOW] });
    await hear(h, 'laptop-1');
    await warning(h, 'server-1', -3 * 3600);
    await warning(h, 'laptop-1', -3600);

    const { lead } = await home(h);

    expect(lead?.detail?.system).toBe('laptop-1');
    expect(lead?.detail?.series?.kind).toBe('percent');
    expect(lead?.stops).toBeUndefined();
  });

  test("counts a down Service's stops over the last week", async () => {
    await using h = await startHub();
    await hear(h, 'server-1', { down: ['api'] });
    await addCondition(h.db.sql, {
      kind: 'service_down',
      level: 'alert',
      raisedAt: -600,
      subject: 'api',
      system: 'server-1',
    });
    await h.db.sql`
      INSERT INTO service_stops (system, service, stopped_at, ongoing, restarts, sent_at, received_at)
      VALUES ('server-1', 'api', ${new Date(NOW - 8 * DAY)}, false, 0, ${new Date(NOW)}, ${new Date(NOW)}),
             ('server-1', 'api', ${new Date(NOW - 2 * DAY)}, false, 0, ${new Date(NOW)}, ${new Date(NOW)}),
             ('server-1', 'api', ${new Date(NOW - 600_000)}, true, 0, ${new Date(NOW)}, ${new Date(NOW)})
    `;

    const { lastCleared, lead } = await home(h);

    expect(lead).toMatchObject({ detail: undefined, stops: 2 });
    expect(lastCleared).toBeUndefined();
  });

  test('with nothing open, names the Condition that cleared last, and none when none ever cleared', async () => {
    await using h = await startHub();
    await hear(h, 'server-1');

    expect((await home(h)).lastCleared).toBeUndefined();

    for (const [clearedAt, kind] of [
      [-7200, 'drift'],
      [-3600, 'low_disk'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- two fixture rows, in order.
      await addCondition(h.db.sql, {
        clearedAt,
        kind,
        level: 'note',
        raisedAt: clearedAt - 600,
        subject: '/',
        system: 'server-1',
      });
    }
    // A newer clear on a System no longer paired is not Home's to name.
    await hear(h, 'laptop-1');
    await addCondition(h.db.sql, {
      clearedAt: -60,
      kind: 'low_disk',
      level: 'note',
      raisedAt: -600,
      subject: '/',
      system: 'laptop-1',
    });
    await unpair(h.db.sql, 'laptop-1');
    const read = await home(h);

    expect(read.lead).toBeUndefined();
    expect(read.lastCleared).toMatchObject({
      clearedAt: NOW - HOUR,
      kind: 'low_disk',
      raisedAt: NOW - HOUR - 600_000,
      system: 'server-1',
    });
  });

  test('sends as many statements for six Systems as for two', async () => {
    await using h = await startHub();
    const statementsFor = async () => {
      const counted = counting(h.db.sql);
      await readHome(counted.sql, { now: NOW, unpaired: false });
      return counted.statements();
    };
    await hear(h, 'server-1', { down: ['api'], up: ['web'] });
    await hear(h, 'laptop-1', { up: ['web'] });
    await warning(h, 'server-1', -3600);
    const two = await statementsFor();
    for (const system of ['edge-1', 'db-1', 'build-1', 'mini-1']) {
      // oxlint-disable-next-line no-await-in-loop -- each System pairs before it reports.
      await pair(h, system);
      // oxlint-disable-next-line no-await-in-loop -- one Report each.
      await hear(h, system, { down: ['api'], up: ['web'] });
      // oxlint-disable-next-line no-await-in-loop -- one Condition each, older than the lead.
      await warning(h, system, -7200);
    }

    expect((await home(h)).lanes).toHaveLength(6);
    expect(await statementsFor()).toBe(two);
    expect(two).toBeGreaterThan(0);
  });
});
