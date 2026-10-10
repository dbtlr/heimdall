import { expect, test } from 'bun:test';

import type { HttpGetResult } from './http-get.ts';
import { healthWords, probeHealth, queueWords, renderStatus, spoolWords } from './status.ts';
import { runWithProxy } from './testing.ts';

const URL_8080 = 'http://127.0.0.1:8080/api/health';

const answering = (status: number, body: unknown, raw?: string) => (): Promise<HttpGetResult> =>
  Promise.resolve({
    body: raw ?? JSON.stringify(body),
    kind: 'response',
    status,
    truncated: false,
  });
const failing = (reason: 'refused' | 'timeout') => (): Promise<HttpGetResult> =>
  Promise.resolve({ kind: 'failed', message: reason, reason });

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
      get: answering(200, { database: 'ok', version: '0.2.0' }),
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
      get: answering(503, { database: 'not answering', version: '0.2.0' }),
      url: URL_8080,
    }),
  ).toEqual({ database: 'not answering', kind: 'answered', version: '0.2.0' });
});

test('a Hub that refuses the connection, times out, or answers something else gave no answer', async () => {
  expect(await probeHealth({ get: failing('refused'), url: URL_8080 })).toEqual({
    kind: 'no answer',
  });
  expect(await probeHealth({ get: failing('timeout'), url: URL_8080 })).toEqual({
    kind: 'no answer',
  });
  expect(await probeHealth({ get: answering(404, { error: 'nope' }), url: URL_8080 })).toEqual({
    kind: 'no answer',
  });
  expect(await probeHealth({ get: answering(200, { database: 'ok' }), url: URL_8080 })).toEqual({
    kind: 'no answer',
  });
  expect(
    await probeHealth({ get: answering(200, null, '{"database": "ok"'), url: URL_8080 }),
  ).toEqual({
    kind: 'no answer',
  });
});

test('the probe asks the address it was given, and no proxy in the environment', async () => {
  const proxied: string[] = [];
  const proxy = Bun.serve({
    fetch: (request) => {
      proxied.push(request.url);
      return Response.json({ database: 'ok', version: 'from the proxy' });
    },
    hostname: '127.0.0.1',
    port: 0,
  });
  const hub = Bun.serve({
    fetch: () => Response.json({ database: 'ok', version: '0.2.0' }),
    hostname: '127.0.0.1',
    port: 0,
  });
  try {
    const printed = await runWithProxy({
      proxy: `http://127.0.0.1:${String(proxy.port)}`,
      script: `
        const { probeHealth } = await import(${JSON.stringify(`${import.meta.dir}/status.ts`)});
        const { httpGet } = await import(${JSON.stringify(`${import.meta.dir}/http-get.ts`)});
        console.log(JSON.stringify(await probeHealth({
          get: httpGet,
          url: 'http://127.0.0.1:${String(hub.port)}/api/health',
        })));
      `,
      variable: 'HTTP_PROXY',
    });

    expect(JSON.parse(printed)).toEqual({ database: 'ok', kind: 'answered', version: '0.2.0' });
    expect(proxied).toEqual([]);
  } finally {
    await proxy.stop(true);
    await hub.stop(true);
  }
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

const NOW = Date.UTC(2026, 9, 9, 12);
const HOUR = 3_600_000;

test('spool words say how much waits and how old it is, or why they cannot', () => {
  const held = (bytes: number, oldestAt: number | null) =>
    spoolWords({ now: NOW, summary: { bytes, oldestAt } });

  expect(spoolWords({ problem: 'file is not a spool' })).toBe('unreadable (file is not a spool)');
  expect(spoolWords({ now: NOW, summary: undefined })).toBe(
    'no spool yet; capture has not started',
  );
  expect(held(0, null)).toBe('empty');
  expect(held(512, NOW - 45_000)).toBe('512 B waiting, oldest spooled 45 s ago');
  expect(held(1536, NOW - 12 * 60_000)).toBe('1.5 KiB waiting, oldest spooled 12 min ago');
  expect(held(12.3 * 1024 ** 2, NOW - 3 * HOUR)).toBe('12.3 MiB waiting, oldest spooled 3 h ago');
  expect(held(1.2 * 1024 ** 3, NOW - 23 * HOUR)).toBe('1.2 GiB waiting, oldest spooled 23 h ago');
});

test('spool words warn when content has waited more than a day for the Hub', () => {
  expect(spoolWords({ now: NOW, summary: { bytes: 2048, oldestAt: NOW - 24 * HOUR } })).toBe(
    '2.0 KiB waiting, oldest spooled 1 d ago',
  );
  expect(spoolWords({ now: NOW, summary: { bytes: 2048, oldestAt: NOW - 50 * HOUR } })).toBe(
    '2.0 KiB waiting, oldest spooled 2 d ago; the Hub has not acknowledged it for over a day',
  );
  expect(spoolWords({ now: NOW, summary: { bytes: 2048, oldestAt: NOW - 25 * HOUR } })).toBe(
    '2.0 KiB waiting, oldest spooled 1 d ago; the Hub has not acknowledged it for over a day',
  );
});
