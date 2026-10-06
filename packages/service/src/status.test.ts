import { expect, test } from 'bun:test';
import { once } from 'node:events';

import { healthWords, probeHealth, queueWords, renderStatus } from './status.ts';

const URL_8080 = 'http://127.0.0.1:8080/api/health';

const answering = (status: number, body: unknown) => () =>
  Promise.resolve(Response.json(body, { status }));
const refused = () => Promise.reject(new Error('Unable to connect'));
// A Hub that never answers: the request ends only when the probe gives up.
const slow = async (_: string, init: { signal: AbortSignal }): Promise<Response> => {
  await once(init.signal, 'abort');
  throw init.signal.reason;
};

test('a status lists the unit state, details, paths, and notes with home as ~', () => {
  const text = renderStatus({
    details: [['health', `ok, v0.2.0 (${URL_8080})`]],
    home: '/home/operator',
    label: 'com.dbtlr.heimdall.hub',
    notes: ['linger is off; the unit stops at logout'],
    paths: {
      config: '/home/operator/.config/heimdall/hub.toml',
      log: '/home/operator/.local/state/heimdall/hub.log',
      unit: '/home/operator/.config/systemd/user/com.dbtlr.heimdall.hub.service',
    },
    summary: 'loaded, running (pid 4182)',
  });

  expect(text).toBe(`com.dbtlr.heimdall.hub: loaded, running (pid 4182)
  health   ok, v0.2.0 (http://127.0.0.1:8080/api/health)
  unit     ~/.config/systemd/user/com.dbtlr.heimdall.hub.service
  log      ~/.local/state/heimdall/hub.log
  config   ~/.config/heimdall/hub.toml
  note     linger is off; the unit stops at logout`);
});

test('a status with no unit path leaves the unit line out', () => {
  const text = renderStatus({
    details: [],
    home: '/home/operator',
    label: 'com.dbtlr.heimdall.collector',
    notes: [],
    paths: { config: '/etc/collector.toml', log: '/home/operator/collector.log' },
    summary: 'not installed',
  });

  expect(text).toBe(`com.dbtlr.heimdall.collector: not installed
  log      ~/collector.log
  config   /etc/collector.toml`);
});

test('a Hub that answers 200 is healthy at the version it reports', async () => {
  expect(
    await probeHealth({
      fetch: answering(200, { database: 'ok', version: '0.2.0' }),
      url: URL_8080,
    }),
  ).toEqual({
    database: 'ok',
    kind: 'answered',
    version: '0.2.0',
  });
});

test('a Hub that answers 503 has a database that is not answering', async () => {
  expect(
    await probeHealth({
      fetch: answering(503, { database: 'not answering', version: '0.2.0' }),
      url: URL_8080,
    }),
  ).toEqual({ database: 'not answering', kind: 'answered', version: '0.2.0' });
});

test('a Hub that refuses the connection, times out, or answers something else gave no answer', async () => {
  expect(await probeHealth({ fetch: refused, url: URL_8080 })).toEqual({ kind: 'no answer' });
  expect(await probeHealth({ fetch: slow, timeoutMs: 10, url: URL_8080 })).toEqual({
    kind: 'no answer',
  });
  expect(await probeHealth({ fetch: answering(404, { error: 'nope' }), url: URL_8080 })).toEqual({
    kind: 'no answer',
  });
  expect(await probeHealth({ fetch: answering(200, { database: 'ok' }), url: URL_8080 })).toEqual({
    kind: 'no answer',
  });
});

test('health words name the state and the running version', () => {
  expect(
    healthWords({ database: 'ok', kind: 'answered', version: '0.2.0' }, '0.2.0', URL_8080),
  ).toBe(`ok, v0.2.0 (${URL_8080})`);
  expect(
    healthWords(
      { database: 'not answering', kind: 'answered', version: '0.2.0' },
      '0.2.0',
      URL_8080,
    ),
  ).toBe(`database not answering, v0.2.0 (${URL_8080})`);
  expect(healthWords({ kind: 'no answer' }, '0.2.0', URL_8080)).toBe(`no answer (${URL_8080})`);
});

test('a running version other than this binary means a restart is pending, either way', () => {
  expect(
    healthWords({ database: 'ok', kind: 'answered', version: '0.1.0' }, '0.2.0', URL_8080),
  ).toBe(`ok, v0.1.0 (${URL_8080}); restart pending, this binary is v0.2.0`);
  expect(
    healthWords({ database: 'ok', kind: 'answered', version: '0.3.0' }, '0.2.0', URL_8080),
  ).toBe(`ok, v0.3.0 (${URL_8080}); restart pending, this binary is v0.2.0`);
});

test('queue words count the samples waiting, or say there is no queue yet', () => {
  expect(queueWords({ samples: 12 })).toBe('12 samples waiting');
  expect(queueWords({ samples: 1 })).toBe('1 sample waiting');
  expect(queueWords({ samples: 0 })).toBe('0 samples waiting');
  expect(queueWords({ samples: undefined })).toBe('no queue yet; run has not started');
  expect(queueWords({ problem: 'database is locked' })).toBe('unreadable (database is locked)');
});
