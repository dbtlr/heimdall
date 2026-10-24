import { beforeAll, expect, test } from 'bun:test';

import { NOW, report, startHub, storeReport, storeToken, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';
import { ServiceStopsReadSchema } from '@heimdall/schema';
import type { SentServiceStop } from '@heimdall/schema';

import { Route } from '../routes/api.v1.service-stops.ts';
import { readServiceStops, serviceStopsAnswer } from './service-stops.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const STOP: SentServiceStop = {
  exitStatus: 1,
  ongoing: false,
  restarts: 2,
  result: 'exit-code',
  service: 'webapp',
  startedAt: NOW - 30_000,
  stoppedAt: NOW - 60_000,
};

const sentStop = (fields: Partial<SentServiceStop>) => ({ ...STOP, ...fields });

const send = (h: Hub, stops: SentServiceStop[], system = 'laptop-1') =>
  storeReport(h.db.sql, {
    receivedAt: NOW + 410,
    report: { ...report(system, []), serviceStops: { stops } },
  });

const ask = (
  h: Hub,
  query = '',
  onError: (error: unknown) => void = (error) => {
    throw error;
  },
) =>
  serviceStopsAnswer({
    database: () => Promise.resolve(h.db.sql),
    onError,
    url: new URL(`http://dashboard.test/api/v1/service-stops${query}`),
  });

const read = async (h: Hub, query = '') => {
  const response = await ask(h, query);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  return ServiceStopsReadSchema.parse(await response.json()).stops;
};

test('reads the stored Service stop with pairing and UTC millisecond times', async () => {
  await using h = await startHub();
  await send(h, [STOP]);

  expect(await read(h)).toEqual([
    {
      exitStatus: 1,
      ongoing: false,
      paired: true,
      receivedAt: '2026-10-06T12:00:00.410Z',
      restarts: 2,
      result: 'exit-code',
      sentAt: '2026-10-06T12:00:00.000Z',
      service: 'webapp',
      startedAt: '2026-10-06T11:59:30.000Z',
      stoppedAt: '2026-10-06T11:59:00.000Z',
      system: 'laptop-1',
    },
  ]);
});

test.each([
  [
    '?system=laptop-1',
    [
      ['laptop-1', 'webapp'],
      ['laptop-1', 'webapp-worker'],
    ],
  ],
  [
    '?service=webapp',
    [
      ['laptop-1', 'webapp'],
      ['server-1', 'webapp'],
    ],
  ],
  ['?system=server-1&service=webapp', [['server-1', 'webapp']]],
  ['?system=laptop', []],
  ['?service=Webapp', []],
  [
    '?ignored=anything',
    [
      ['laptop-1', 'webapp'],
      ['laptop-1', 'webapp-worker'],
      ['server-1', 'webapp'],
    ],
  ],
])('filters by exact System and Service names: %s', async (query, expected) => {
  await using h = await startHub();
  await send(h, [STOP, { ...STOP, service: 'webapp-worker' }]);
  await send(h, [STOP], 'server-1');

  expect((await read(h, query)).map((stop) => [stop.system, stop.service])).toEqual(expected);
});

test('since includes the boundary and newer stops, using stoppedAt rather than the Report time', async () => {
  await using h = await startHub();
  await send(
    h,
    [-1, 0, 1].map((offset) => sentStop({ stoppedAt: STOP.stoppedAt + offset })),
  );

  const stops = await read(h, '?since=2026-10-06T13:59:00%2B02:00');
  expect(stops.map((stop) => stop.stoppedAt)).toEqual([
    '2026-10-06T11:59:00.001Z',
    '2026-10-06T11:59:00.000Z',
  ]);
});

test("orders Systems and Services by code unit, then each Service's stops newest first", async () => {
  await using h = await startHub();
  await Promise.all(
    ['a_b', 'ab', 'a-c', 'a-b', 'B'].map(async (system) => {
      await storeToken(h.db.sql, { pairedAt: NOW, system, token: `${system}-token` });
      const stops = ['a_b', 'ab', 'a-c', 'a-b', 'B'].map((service) => sentStop({ service }));
      await send(h, stops, system);
    }),
  );
  await send(h, [{ ...STOP, service: 'B', stoppedAt: STOP.stoppedAt + 1 }], 'B');

  const stops = await read(h);
  expect([...new Set(stops.map((stop) => stop.system))]).toEqual(['B', 'a-b', 'a-c', 'a_b', 'ab']);
  expect(
    stops.filter((stop) => stop.system === 'B').map((stop) => [stop.service, stop.stoppedAt]),
  ).toEqual([
    ['B', '2026-10-06T11:59:00.001Z'],
    ['B', '2026-10-06T11:59:00.000Z'],
    ['a-b', '2026-10-06T11:59:00.000Z'],
    ['a-c', '2026-10-06T11:59:00.000Z'],
    ['a_b', '2026-10-06T11:59:00.000Z'],
    ['ab', '2026-10-06T11:59:00.000Z'],
  ]);
});

test('the reusable read accepts System, Service, and since filters together', async () => {
  await using h = await startHub();
  await send(h, [STOP, { ...STOP, service: 'worker' }, { ...STOP, stoppedAt: STOP.stoppedAt - 1 }]);
  await send(h, [STOP], 'server-1');

  const stops = await readServiceStops(h.db.sql, {
    includeUnpaired: false,
    service: 'webapp',
    since: new Date(STOP.stoppedAt),
    system: 'laptop-1',
  });
  expect(stops).toEqual(
    await read(h, '?system=laptop-1&service=webapp&since=2026-10-06T11:59:00Z'),
  );
  expect(stops).toHaveLength(1);
});

test('hides unpaired Systems unless include is requested, including when repeated', async () => {
  await using h = await startHub();
  await send(h, [STOP]);
  await send(h, [STOP], 'server-1');
  await unpair(h.db.sql, 'laptop-1');

  expect((await read(h)).map((stop) => [stop.system, stop.paired])).toEqual([['server-1', true]]);
  expect(await read(h, '?system=laptop-1')).toEqual([]);
  const included = await Promise.all(
    ['?unpaired=include', '?unpaired=include&unpaired=include'].map((query) => read(h, query)),
  );
  for (const stops of included) {
    expect(stops.map((stop) => [stop.system, stop.paired])).toEqual([
      ['laptop-1', false],
      ['server-1', true],
    ]);
  }
  await storeToken(h.db.sql, { pairedAt: NOW, system: 'laptop-1', token: 'new-token' });
  expect((await read(h)).map((stop) => stop.system)).toEqual(['laptop-1', 'server-1']);
});

test.each([
  '?unpaired=yes',
  '?unpaired=INCLUDE',
  '?unpaired=',
  '?unpaired',
  '?unpaired=include&unpaired=yes',
])('refuses an invalid unpaired value before opening the database: %s', async (query) => {
  const response = await serviceStopsAnswer({
    database: () => {
      throw new Error('The database must not be opened.');
    },
    onError: (error) => {
      throw error;
    },
    url: new URL(`http://dashboard.test/api/v1/service-stops${query}`),
  });

  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toContain('text/plain');
  expect(await response.text()).toBe('The only value for unpaired is include: ?unpaired=include.');
});

test.each([
  '?system=laptop-1&system=laptop-1',
  '?service=webapp&service=worker',
  '?since=2026-10-06T11:59:00Z&since=2026-10-06T11:59:00Z',
  '?system=',
  '?system',
  '?service=',
  '?service',
  '?since=',
  '?since',
  '?since=not-a-time',
  '?since=2026-10-06',
  '?since=October%206,%202026%2012:00:00%20UTC',
  '?since=2026-13-06T12:00:00Z',
  '?since=2026-02-30T00:00:00Z',
  '?since=2026-04-31T00:00:00Z',
  '?since=2026-10-06T24:00:00Z',
])('refuses an invalid filter before opening the database: %s', async (query) => {
  const response = await serviceStopsAnswer({
    database: () => {
      throw new Error('The database must not be opened.');
    },
    onError: (error) => {
      throw error;
    },
    url: new URL(`http://dashboard.test/api/v1/service-stops${query}`),
  });

  expect(response.status).toBe(400);
  expect(response.headers.get('content-type')).toContain('text/plain');
  expect((await response.text()).length).toBeGreaterThan(0);
});

test('answers an empty list when the Hub holds no stops', async () => {
  await using h = await startHub();
  expect(await read(h)).toEqual([]);
});

test('preserves null fields for ongoing stops and stops whose end was never observed', async () => {
  await using h = await startHub();
  await send(h, [
    { ...STOP, exitStatus: null, ongoing: true, result: null, startedAt: null },
    { ...STOP, exitStatus: null, result: null, service: 'worker', startedAt: null },
  ]);

  expect(
    (await read(h)).map(({ exitStatus, ongoing, result, startedAt }) => ({
      exitStatus,
      ongoing,
      result,
      startedAt,
    })),
  ).toEqual([
    { exitStatus: null, ongoing: true, result: null, startedAt: null },
    { exitStatus: null, ongoing: false, result: null, startedAt: null },
  ]);
});

test('reads expanded-year times the Hub accepts without losing milliseconds', async () => {
  await using h = await startHub();
  await send(h, [
    { ...STOP, startedAt: 8_640_000_000_000_000, stoppedAt: Date.UTC(10_000, 0, 1) + 1 },
  ]);

  expect((await read(h))[0]).toMatchObject({
    startedAt: '+275760-09-13T00:00:00.000Z',
    stoppedAt: '+010000-01-01T00:00:00.001Z',
  });
});

test('answers 503 and reports a database that cannot be opened', async () => {
  const errors: unknown[] = [];
  const response = await serviceStopsAnswer({
    database: () => Promise.reject(new Error('No database URL')),
    onError: (error) => errors.push(error),
    url: new URL('http://dashboard.test/api/v1/service-stops'),
  });

  expect(response.status).toBe(503);
  expect(response.headers.get('content-type')).toContain('text/plain');
  expect(await response.text()).toBe('The dashboard cannot answer right now; try again later.');
  expect(errors).toEqual([new Error('No database URL')]);
});

test('answers 503 and reports a database that cannot answer', async () => {
  const h = await startHub();
  await h.db.sql.close();
  const errors: unknown[] = [];
  const response = await ask(h, '', (error) => errors.push(error));

  expect(response.status).toBe(503);
  expect(errors).toHaveLength(1);
  await h.db[Symbol.asyncDispose]().catch(() => undefined);
});

test('the route hands its request query to the answer', async () => {
  const handlers = Route.options.server?.handlers;
  const handler = typeof handlers === 'object' ? handlers.GET : undefined;
  const request = new Request('http://dashboard.test/api/v1/service-stops?unpaired=INCLUDE');
  const response = await (handler as (ctx: { request: Request }) => Promise<Response>)({ request });

  expect(response.status).toBe(400);
});

test('the route answers methods other than GET with 405', async () => {
  const handlers = Route.options.server?.handlers;
  const handler = typeof handlers === 'object' ? handlers.ANY : undefined;
  expect(handler).toBeDefined();
  const response = await (handler as () => Response | Promise<Response>)();

  expect(response.status).toBe(405);
  expect(response.headers.get('allow')).toBe('GET, HEAD');
  expect(await response.text()).toBe('Only GET is answered here.');
});
