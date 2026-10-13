import { expect, test } from 'bun:test';

import { MAX_REPORT_BYTES, MAX_SAMPLES_PER_REPORT } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';
import { SQL } from 'bun';

import packageJson from '../package.json' with { type: 'json' };
import { createHub } from './hub.ts';
import { listSystems, NOW, push, report, silentServer, startHub } from './testing/hub.ts';

test('a Report without a token is refused as unauthenticated', async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('laptop-1', [NOW]));

  expect(response.status).toBe(401);
});

// A wrong token answers 403, like a token for another System, so the Collector
// keeps its Reports until the token is fixed (ADR-0004).
test('a Report with an unknown token is forbidden', async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('laptop-1', [NOW]), { token: 'guess' });

  expect(response.status).toBe(403);
});

test('the bearer scheme is read in any case', async () => {
  await using h = await startHub();

  const response = await h.hub.fetch(
    new Request('http://hub.test/api/v1/reports', {
      body: JSON.stringify(report('laptop-1', [NOW])),
      headers: { authorization: 'bearer laptop-token' },
      method: 'POST',
    }),
  );

  expect(response.status).toBe(200);
});

test("a Report for another System than the token's is forbidden", async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('server-1', [NOW]), { token: 'laptop-token' });

  expect(response.status).toBe(403);
});

test.each([
  ['a body that is not JSON', '{"system": "laptop-1",'],
  ['a Report that fails the schema', { ...report('laptop-1', [NOW]), samples: [] }],
  ['a Report of an unknown schema version', { ...report('laptop-1', [NOW]), schemaVersion: 99 }],
])('%s is rejected as invalid, with the reason', async (_, body) => {
  await using h = await startHub();

  const response = await push(h.hub, body, { token: 'laptop-token' });

  expect(response.status).toBe(422);
  expect(await response.text()).not.toBe('');
});

test('a body over the size cap is rejected as invalid', async () => {
  await using h = await startHub();
  const padding = 'x'.repeat(MAX_REPORT_BYTES);

  const response = await push(
    h.hub,
    { ...report('laptop-1', [NOW]), padding },
    { token: 'laptop-token' },
  );

  expect(response.status).toBe(422);
});

test('a Report just over the old 4 MiB cap is accepted', async () => {
  await using h = await startHub();
  const filler = 'x'.repeat(256);
  const records = {
    records: Array.from({ length: 12_000 }, (_, i) => {
      const name = `svc-${String(i)}`;
      return {
        kind: 'service',
        name,
        record: { name, supervisor: 'systemd', unit: `${filler}${String(i)}.service` },
      };
    }),
    unreadable: [],
  };
  const body = JSON.stringify({ ...report('laptop-1', [NOW]), records });
  expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
  expect(body.length).toBeLessThan(MAX_REPORT_BYTES);

  const response = await push(h.hub, body, { token: 'laptop-token' });

  expect(response.status).toBe(200);
});

test('the largest Report the schema allows fits under the size cap', async () => {
  await using h = await startHub();
  const times = Array.from({ length: MAX_SAMPLES_PER_REPORT }, (_, i) => NOW + i * 15_000);
  const largest = report('laptop-1', times);
  for (const s of largest.samples) {
    s.disks = Array.from({ length: 8 }, (_, i) => ({
      mount: `/Volumes/A Rather Long Volume Name ${String(i)}`,
      totalBytes: 994_662_584_320,
      usedBytes: 412_316_860_416,
    }));
  }

  const response = await push(h.hub, largest, { token: 'laptop-token' });

  expect(response.status).toBe(200);
});

test('an accepted Report answers how many samples it stored', async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('laptop-1', [NOW - 15_000, NOW]), {
    token: 'laptop-token',
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ skipped: 0, stored: 2 });
});

test('samples the Hub already holds are skipped, and the rest stored', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW - 30_000, NOW - 15_000]), { token: 'laptop-token' });

  const response = await push(h.hub, report('laptop-1', [NOW - 15_000, NOW]), {
    token: 'laptop-token',
  });

  expect(await response.json()).toEqual({ skipped: 1, stored: 1 });
});

test('samples are keyed by System, so two Systems may share a time', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });

  const response = await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });

  expect(await response.json()).toEqual({ skipped: 0, stored: 1 });
});

test('the Hub serves no page at /, since the dashboard serves every page', async () => {
  await using h = await startHub();

  const responses = await Promise.all(
    ['/', '/?unpaired'].map((path) => h.hub.fetch(new Request(`http://hub.test${path}`))),
  );

  expect(responses.map((r) => r.status)).toEqual([404, 404]);
});

test('a Report the Hub clock places earlier does not move last seen back', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  h.clock.now = NOW - 60 * 60_000;
  await push(h.hub, report('laptop-1', [NOW + 15_000]), { token: 'laptop-token' });

  expect((await listSystems(h.db.sql))[0]?.lastSeenAt).toBe(NOW);
});

test('a Report of samples the Hub already holds still counts as seeing the System', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  h.clock.now = NOW + 60 * 60_000;
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });

  expect((await listSystems(h.db.sql))[0]?.lastSeenAt).toBe(NOW + 60 * 60_000);
});

// PostgreSQL cannot store NUL or a lone surrogate. Refusing the Report would
// stall the Collector's queue behind it, so the Hub stores a replacement character.
test('text PostgreSQL cannot store is kept as a replacement character', async () => {
  await using h = await startHub();
  const odd = {
    ...sample(NOW),
    disks: [{ mount: '/a\u0000b\uD800c', totalBytes: 1, usedBytes: 0 }],
  };

  const response = await push(
    h.hub,
    {
      ...report('laptop-1', [NOW]),
      collector: { arch: 'arm\u000064', platform: 'darwin', version: '0.1\u0000' },
      samples: [odd],
    },
    { token: 'laptop-token' },
  );

  expect(response.status).toBe(200);
  const [stored] = await h.db.sql`
    SELECT s.collector_version, s.collector_arch, v.disks
    FROM systems s JOIN vitals_samples v ON v.system = s.name
  `;
  expect(stored).toEqual({
    collector_arch: 'arm�64',
    collector_version: '0.1�',
    disks: [{ mount: '/a�b�c', totalBytes: 1, usedBytes: 0 }],
  });
});

test('sample times up to the last a Date can hold are stored exactly', async () => {
  await using h = await startHub();
  const last = 8_640_000_000_000_000;
  const times = Array.from({ length: MAX_SAMPLES_PER_REPORT }, (_, i) => last - 1000 + i);

  const response = await push(h.hub, report('laptop-1', times), { token: 'laptop-token' });

  expect(await response.json()).toEqual({ skipped: 0, stored: MAX_SAMPLES_PER_REPORT });
  const [newest] = await h.db.sql`SELECT max(t) AS t FROM vitals_samples`;
  expect(newest.t.getTime()).toBe(last - 1);
});

test('a Report the database cannot take is answered 503, so the Collector retries it', async () => {
  await using h = await startHub();
  await h.db.sql.close();

  const response = await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });

  expect(response.status).toBe(503);
  expect(h.errors).toHaveLength(1);
});

const getHealth = (hub: Awaited<ReturnType<typeof startHub>>['hub']) =>
  hub.fetch(new Request('http://hub.test/api/health'));

test('the health check answers 200 with the Hub version when the database answers', async () => {
  await using h = await startHub();

  const response = await getHealth(h.hub);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({ database: 'ok', version: packageJson.version });
});

test('the health check answers 503 when the database does not answer, without logging it', async () => {
  await using h = await startHub();
  await h.db.sql.close();

  const response = await getHealth(h.hub);

  expect(response.status).toBe(503);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(await response.json()).toEqual({
    database: 'not answering',
    version: packageJson.version,
  });
  expect(h.errors).toHaveLength(0);
});

// A server that accepts the connection and never replies stands in for a
// database that hangs; the check must give up long before the 30 s statement timeout.
test('the health check gives up on a database that hangs', async () => {
  await using h = await startHub();
  await using silent = silentServer();
  const sql = new SQL(`postgres://heimdall@localhost:${String(silent.port)}/heimdall`);
  const hub = createHub({
    healthTimeoutMs: 50,
    now: () => NOW,
    onError: (error) => h.errors.push(error),
    sql,
  });

  // Closing a connection stuck in its handshake would hang too, so it is not awaited.
  const response = await getHealth(hub).finally(() => void sql.close({ timeout: 0 }));

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    database: 'not answering',
    version: packageJson.version,
  });
  expect(h.errors).toHaveLength(0);
});

test('only GET reaches the health check', async () => {
  await using h = await startHub();

  const response = await h.hub.fetch(new Request('http://hub.test/api/health', { method: 'POST' }));

  expect(response.status).toBe(404);
});
