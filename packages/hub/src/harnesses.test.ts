import { expect, test } from 'bun:test';

import type { HarnessesSection } from '@heimdall/schema';

import { listSystems } from './store.ts';
import { NOW, page, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

const CLAUDE = { harness: 'claude-code', location: 'mise', version: '2.1.296' };
const CODEX = { harness: 'codex', location: 'npm', version: '0.162.1' };

// Pushes a Report from `system` sent at `sentAt` that carries `harnesses`, or
// none when it is undefined.
const pushInstalls = async (
  h: Hub,
  system: 'laptop-1' | 'server-1',
  {
    harnesses,
    sentAt = NOW,
    t = sentAt,
  }: { harnesses?: HarnessesSection; sentAt?: number; t?: number },
) => {
  const response = await push(
    h.hub,
    { ...report(system, [t]), sentAt, ...(harnesses === undefined ? {} : { harnesses }) },
    { token: system === 'laptop-1' ? 'laptop-token' : 'server-token' },
  );
  expect(response.status).toBe(200);
};

const installsOf = async (h: Hub, name: string) =>
  (await listSystems(h.db.sql)).find((s) => s.name === name)?.harnesses;

test('a System that never sent the section has no known installs', async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', {});

  expect(await installsOf(h, 'laptop-1')).toBeUndefined();
});

test("the Hub keeps each System's installs from its latest Report that carried them", async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', { harnesses: { installs: [CLAUDE] } });
  await pushInstalls(h, 'server-1', { harnesses: { installs: [CODEX] } });
  await pushInstalls(h, 'laptop-1', {
    harnesses: { installs: [CLAUDE, CODEX] },
    sentAt: NOW + 60_000,
    t: NOW + 15_000,
  });

  expect(await installsOf(h, 'laptop-1')).toEqual([CLAUDE, CODEX]);
  expect(await installsOf(h, 'server-1')).toEqual([CODEX]);
});

test('a Report without the section leaves the installs the Hub holds', async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', { harnesses: { installs: [CLAUDE] } });
  await pushInstalls(h, 'laptop-1', { sentAt: NOW + 60_000, t: NOW + 15_000 });

  expect(await installsOf(h, 'laptop-1')).toEqual([CLAUDE]);
});

test('an empty list replaces the installs, since the Harness was removed', async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', { harnesses: { installs: [CLAUDE] } });
  await pushInstalls(h, 'laptop-1', {
    harnesses: { installs: [] },
    sentAt: NOW + 60_000,
    t: NOW + 15_000,
  });

  expect(await installsOf(h, 'laptop-1')).toEqual([]);
});

test('a Report sent earlier does not replace installs from one sent later', async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', { harnesses: { installs: [CODEX] }, sentAt: NOW });
  await pushInstalls(h, 'laptop-1', {
    harnesses: { installs: [CLAUDE] },
    sentAt: NOW - 60_000,
    t: NOW - 15_000,
  });

  expect(await installsOf(h, 'laptop-1')).toEqual([CODEX]);
});

test('the newest Report sent wins whatever order they arrive in', async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', { harnesses: { installs: [CODEX] }, sentAt: NOW - 120_000 });
  await pushInstalls(h, 'laptop-1', {
    harnesses: { installs: [CLAUDE] },
    sentAt: NOW,
    t: NOW + 1_000,
  });
  await pushInstalls(h, 'laptop-1', {
    harnesses: { installs: [CODEX, CLAUDE] },
    sentAt: NOW - 60_000,
    t: NOW + 2_000,
  });

  expect(await installsOf(h, 'laptop-1')).toEqual([CLAUDE]);
});

test('installs claiming a time after the Hub received them give way to a correct Report', async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', {
    harnesses: { installs: [CODEX] },
    sentAt: NOW + 24 * 3_600_000,
  });
  await pushInstalls(h, 'laptop-1', {
    harnesses: { installs: [CLAUDE] },
    sentAt: NOW,
    t: NOW + 15_000,
  });

  expect(await installsOf(h, 'laptop-1')).toEqual([CLAUDE]);
});

test("the page shows each System's Harnesses and their versions", async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', { harnesses: { installs: [CLAUDE, CODEX] } });
  await pushInstalls(h, 'server-1', { harnesses: { installs: [] } });

  const html = await page(h.hub);

  expect(html).toContain('<th>Harnesses</th>');
  expect(html).toContain('claude-code 2.1.296 (mise)<br>codex 0.162.1 (npm)');
  expect(html).toContain('None installed');
});

test('the page shows an unknown version as unknown, and escapes what Collectors report', async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', {
    harnesses: {
      installs: [{ harness: '<b>x</b>', location: '<i>y</i>', version: 'unknown' }],
    },
  });

  const html = await page(h.hub);

  expect(html).toContain('&lt;b&gt;x&lt;/b&gt; unknown (&lt;i&gt;y&lt;/i&gt;)');
  expect(html).not.toContain('<b>x</b>');
  expect(html).not.toContain('<i>y</i>');
});

test('the page shows a dash for a System that never sent the section', async () => {
  await using h = await startHub();
  await pushInstalls(h, 'laptop-1', {});

  const row = (await page(h.hub)).split('<tr>').find((r) => r.includes('laptop-1')) ?? '';

  expect(row).toMatch(/<td>—<\/td><\/tr>/u);
});
