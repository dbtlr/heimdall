import { expect, test } from 'bun:test';

import { MAX_SAMPLES_PER_REPORT } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { MAX_REPORT_BYTES } from './hub.ts';
import { listSystems } from './store.ts';
import { NOW, page, push, report, startHub } from './testing/hub.ts';

test('a Report without a token is refused as unauthenticated', async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('db-mbp', [NOW]));

  expect(response.status).toBe(401);
});

// A wrong token answers 403, like a token for another System, so the Collector
// keeps its Reports until the token is fixed (ADR-0004).
test('a Report with an unknown token is forbidden', async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('db-mbp', [NOW]), { token: 'guess' });

  expect(response.status).toBe(403);
});

test('the bearer scheme is read in any case', async () => {
  await using h = await startHub();

  const response = await h.hub.fetch(
    new Request('http://hub.test/api/v1/reports', {
      body: JSON.stringify(report('db-mbp', [NOW])),
      headers: { authorization: 'bearer mbp-token' },
      method: 'POST',
    }),
  );

  expect(response.status).toBe(200);
});

test("a Report for another System than the token's is forbidden", async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('asgard', [NOW]), { token: 'mbp-token' });

  expect(response.status).toBe(403);
});

test.each([
  ['a body that is not JSON', '{"system": "db-mbp",'],
  ['a Report that fails the schema', { ...report('db-mbp', [NOW]), samples: [] }],
  ['a Report of an unknown schema version', { ...report('db-mbp', [NOW]), schemaVersion: 99 }],
])('%s is rejected as invalid, with the reason', async (_, body) => {
  await using h = await startHub();

  const response = await push(h.hub, body, { token: 'mbp-token' });

  expect(response.status).toBe(422);
  expect(await response.text()).not.toBe('');
});

test('a body over the size cap is rejected as invalid', async () => {
  await using h = await startHub();
  const padding = 'x'.repeat(MAX_REPORT_BYTES);

  const response = await push(
    h.hub,
    { ...report('db-mbp', [NOW]), padding },
    { token: 'mbp-token' },
  );

  expect(response.status).toBe(422);
});

test('the largest Report the schema allows fits under the size cap', async () => {
  await using h = await startHub();
  const times = Array.from({ length: MAX_SAMPLES_PER_REPORT }, (_, i) => NOW + i * 15_000);
  const largest = report('db-mbp', times);
  for (const s of largest.samples) {
    s.disks = Array.from({ length: 8 }, (_, i) => ({
      mount: `/Volumes/A Rather Long Volume Name ${String(i)}`,
      totalBytes: 994_662_584_320,
      usedBytes: 412_316_860_416,
    }));
  }

  const response = await push(h.hub, largest, { token: 'mbp-token' });

  expect(response.status).toBe(200);
});

test('an accepted Report answers how many samples it stored', async () => {
  await using h = await startHub();

  const response = await push(h.hub, report('db-mbp', [NOW - 15_000, NOW]), {
    token: 'mbp-token',
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ skipped: 0, stored: 2 });
});

test('samples the Hub already holds are skipped, and the rest stored', async () => {
  await using h = await startHub();
  await push(h.hub, report('db-mbp', [NOW - 30_000, NOW - 15_000]), { token: 'mbp-token' });

  const response = await push(h.hub, report('db-mbp', [NOW - 15_000, NOW]), {
    token: 'mbp-token',
  });

  expect(await response.json()).toEqual({ skipped: 1, stored: 1 });
});

test('samples are keyed by System, so two Systems may share a time', async () => {
  await using h = await startHub();
  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });

  const response = await push(h.hub, report('asgard', [NOW]), { token: 'asgard-token' });

  expect(await response.json()).toEqual({ skipped: 0, stored: 1 });
});

test('the page says so when no System has reported', async () => {
  await using h = await startHub();

  expect(await page(h.hub)).toContain('No System has reported yet.');
});

test("the page lists each System with its last-seen time and newest sample's Vitals", async () => {
  await using h = await startHub();
  const newest = {
    ...sample(NOW),
    cpu: { busyPercent: 61.25 },
    disks: [{ mount: '/', totalBytes: 500 * 2 ** 30, usedBytes: 125 * 2 ** 30 }],
    load: [2.5, 1.75, 1] as [number, number, number],
    memory: { totalBytes: 32 * 2 ** 30, usedBytes: 8 * 2 ** 30 },
    uptimeSeconds: 2 * 86_400 + 3 * 3600 + 5 * 60,
  };
  await push(
    h.hub,
    { ...report('db-mbp', [NOW - 15_000]), samples: [sample(NOW - 15_000), newest] },
    {
      token: 'mbp-token',
    },
  );
  h.clock.now = NOW + 5 * 60_000;
  await push(h.hub, report('asgard', [NOW]), { token: 'asgard-token' });

  const html = await page(h.hub);

  expect(html).toContain('asgard');
  expect(html).toContain('db-mbp');
  expect(html).toContain('2026-10-06 12:00:00 UTC');
  expect(html).toContain('5 min ago');
  expect(html).toContain('61.3%');
  expect(html).toContain('8.0 / 32.0 GiB');
  expect(html).toContain('/ 125.0 / 500.0 GiB');
  expect(html).toContain('2.50 1.75 1.00');
  expect(html).toContain('2d 3h 5m');
  expect(html).toContain('0.1.0 darwin/arm64');
});

test('a Report the Hub clock places earlier does not move last seen back', async () => {
  await using h = await startHub();
  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });
  h.clock.now = NOW - 60 * 60_000;
  await push(h.hub, report('db-mbp', [NOW + 15_000]), { token: 'mbp-token' });

  expect(await page(h.hub)).toContain('2026-10-06 12:00:00 UTC');
});

test('a Report of samples the Hub already holds still counts as seeing the System', async () => {
  await using h = await startHub();
  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });
  h.clock.now = NOW + 60 * 60_000;
  await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });

  expect(await page(h.hub)).toContain('2026-10-06 13:00:00 UTC');
});

test('the page escapes what Collectors report', async () => {
  await using h = await startHub();
  const hostile = {
    ...sample(NOW),
    disks: [{ mount: '/Volumes/<b>x</b> & "y"', totalBytes: 1, usedBytes: 0 }],
  };
  await push(
    h.hub,
    {
      ...report('db-mbp', [NOW]),
      collector: { arch: '<i>arm64</i>', platform: 'darwin', version: '0.1.0' },
      samples: [hostile],
    },
    { token: 'mbp-token' },
  );

  const html = await page(h.hub);

  expect(html).toContain('/Volumes/&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;');
  expect(html).toContain('darwin/&lt;i&gt;arm64&lt;/i&gt;');
  expect(html).not.toContain('<b>');
  expect(html).not.toContain('<i>');
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
      ...report('db-mbp', [NOW]),
      collector: { arch: 'arm\u000064', platform: 'darwin', version: '0.1\u0000' },
      samples: [odd],
    },
    { token: 'mbp-token' },
  );

  expect(response.status).toBe(200);
  const html = await page(h.hub);
  expect(html).toContain('/a�b�c');
  expect(html).toContain('0.1� darwin/arm�64');
});

test('sample times up to the last a Date can hold are stored exactly', async () => {
  await using h = await startHub();
  const last = 8_640_000_000_000_000;
  const times = Array.from({ length: MAX_SAMPLES_PER_REPORT }, (_, i) => last - 1000 + i);

  const response = await push(h.hub, report('db-mbp', times), { token: 'mbp-token' });

  expect(await response.json()).toEqual({ skipped: 0, stored: MAX_SAMPLES_PER_REPORT });
  const [system] = await listSystems(h.db.sql);
  expect(system?.reported?.latest.t).toBe(last - 1);
});

test('a Report the database cannot take is answered 503, so the Collector retries it', async () => {
  await using h = await startHub();
  await h.db.sql.close();

  const response = await push(h.hub, report('db-mbp', [NOW]), { token: 'mbp-token' });

  expect(response.status).toBe(503);
  expect(h.errors).toHaveLength(1);
});
