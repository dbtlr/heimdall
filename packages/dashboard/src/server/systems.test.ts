import { expect, test } from 'bun:test';

import { issue, NOW, push, redeem, report, startHub, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { listPairedSystems } from './systems.ts';

// Pairs `name` through the Hub's own pairing flow and answers its token.
const pair = async (h: Hub, name: string) => {
  const response = await redeem(h.hub, { code: await issue(h, name) });
  return ((await response.json()) as { token: string }).token;
};

test('lists each paired System with when it was last seen, by name', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });

  const systems = await listPairedSystems(h.db.sql);

  // `laptop-1` is paired but has never reported.
  expect(systems).toEqual([
    { lastSeenAt: undefined, name: 'laptop-1' },
    { lastSeenAt: NOW, name: 'server-1' },
  ]);
});

test('leaves out a System that was unpaired, though the Hub keeps its history', async () => {
  await using h = await startHub();
  const token = await pair(h, 'desk-1');
  await push(h.hub, report('desk-1', [NOW]), { token });
  await unpair(h.db.sql, 'desk-1');

  const names = (await listPairedSystems(h.db.sql)).map((system) => system.name);

  expect(names).toEqual(['laptop-1', 'server-1']);
});

test('reports the newest time the Hub heard from a System', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  h.clock.now = NOW + 90_000;
  await push(h.hub, report('server-1', [NOW + 15_000]), { token: 'server-token' });

  const server = (await listPairedSystems(h.db.sql)).find(({ name }) => name === 'server-1');

  expect(server?.lastSeenAt).toBe(NOW + 90_000);
});
