import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';
import type { SentServiceStop } from '@heimdall/schema';

import { parseServiceDetailInput, readServiceDetail } from './service-detail.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const { addCondition } = timeline(NOW);

const WEB = { name: 'web', supervisor: 'systemd', unit: 'web.service' };

const stop = (over: Partial<SentServiceStop> = {}): SentServiceStop => ({
  exitStatus: 1,
  ongoing: false,
  restarts: 2,
  result: 'exit-code',
  service: 'web',
  startedAt: NOW - HOUR + MINUTE,
  stoppedAt: NOW - HOUR,
  ...over,
});

const hear = async (h: Hub, system: string, sections: Record<string, unknown> = {}) => {
  h.clock.now = NOW;
  const response = await push(
    h.hub,
    { ...report(system, [NOW]), ...sections },
    { token: `${system.split('-')[0]}-token` },
  );
  expect(response.status).toBe(200);
};

const checks = {
  services: [
    {
      check: 'supervisor',
      detail: 'ActiveState=active',
      service: 'web',
      since: NOW - DAY,
      state: 'up',
    },
  ],
};
const records = { records: [{ kind: 'service', name: 'web', record: WEB }], unreadable: [] };

const read = (h: Hub, system = 'server-1', service = 'web') =>
  readServiceDetail(h.db.sql, { now: NOW, service, system });

test('reads the record, its checks, the open note, and the stops, newest first', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', {
    checks,
    records,
    serviceStops: {
      stops: [
        stop({ startedAt: NOW - 5 * HOUR + MINUTE, stoppedAt: NOW - 5 * HOUR }),
        stop(),
        stop({ service: 'other' }),
        stop({ startedAt: NOW - 100 * DAY + MINUTE, stoppedAt: NOW - 100 * DAY }),
      ],
    },
  });
  await addCondition(h.db.sql, {
    kind: 'service_restarted',
    level: 'note',
    raisedAt: -3600,
    reason: 'The Service stopped twice.',
    subject: 'web',
    system: 'server-1',
  });
  await addCondition(h.db.sql, {
    clearedAt: -60,
    kind: 'service_restarted',
    level: 'note',
    raisedAt: -7200,
    subject: 'web',
    system: 'server-1',
  });

  const found = await read(h);

  expect(found?.recorded).toEqual({
    checks: [{ check: 'supervisor', detail: 'ActiveState=active', since: NOW - DAY, state: 'up' }],
    name: 'web',
    supervisor: 'systemd',
  });
  expect(found?.unit).toBe('web.service');
  expect(found?.note).toMatchObject({
    raisedAt: NOW - HOUR,
    reason: 'The Service stopped twice.',
  });
  expect(found?.stops.map(({ service, stoppedAt }) => [service, Date.parse(stoppedAt)])).toEqual([
    ['web', NOW - HOUR],
    ['web', NOW - 5 * HOUR],
  ]);
  expect(found).toMatchObject({ now: NOW, service: 'web', system: 'server-1' });
});

test('has no note when none is open', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', { records });
  expect((await read(h))?.note).toBeUndefined();
});

test('a Service its provisioner forgot still opens while it has stops', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', { serviceStops: { stops: [stop()] } });

  const found = await read(h);

  expect(found?.recorded).toBeUndefined();
  expect(found?.unit).toBeUndefined();
  expect(found?.stops).toHaveLength(1);
});

test('a recorded Service with no stops opens', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', { records });
  expect((await read(h))?.stops).toEqual([]);
});

test('an unknown System or Service is undefined', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', { records });

  expect(await read(h, 'nobody-1')).toBeUndefined();
  expect(await read(h, 'server-1', 'ghost')).toBeUndefined();
});

test('an unpaired System opens as it was left', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', { records, serviceStops: { stops: [stop()] } });
  await unpair(h.db.sql, 'server-1');

  const found = await read(h);

  expect(found?.recorded?.name).toBe('web');
  expect(found?.stops).toHaveLength(1);
});

describe('parseServiceDetailInput', () => {
  test('takes a System and a Service name', () => {
    expect(parseServiceDetailInput({ name: 'server-1', service: 'web' })).toEqual({
      name: 'server-1',
      service: 'web',
    });
  });

  test('refuses a missing or empty name', () => {
    expect(() => parseServiceDetailInput({ service: 'web' })).toThrow('names no System');
    expect(() => parseServiceDetailInput({ name: 'server-1', service: '' })).toThrow(
      'names no Service',
    );
  });
});
