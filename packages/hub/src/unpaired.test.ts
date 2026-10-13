import { expect, test } from 'bun:test';

import { unpair } from './pairing.ts';
import { evaluateSystemConditions, SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { issue, listSystems, NOW, push, redeem, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';

const MINUTE = 60_000;

// Both paired Systems report; then `laptop-1` is unpaired.
const unpairedLaptop = async (h: Hub) => {
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  await unpair(h.db.sql, 'laptop-1');
};

// Judges the System Conditions at `time`.
const evaluate = (h: Hub, time: number) => {
  h.clock.now = time;
  return evaluateSystemConditions(h.db.sql, () => h.clock.now, SYSTEM_CONDITION_THRESHOLDS);
};

// Whether each System the Hub holds is paired, by name.
const pairing = async (h: Hub) =>
  (await listSystems(h.db.sql)).map((s): [string, boolean] => [s.name, s.paired]);

test('the Hub still holds an unpaired System and marks which Systems are paired', async () => {
  await using h = await startHub();
  await unpairedLaptop(h);

  expect(await pairing(h)).toEqual([
    ['laptop-1', false],
    ['server-1', true],
  ]);
});

test('a paired System with no Report yet is still paired', async () => {
  await using h = await startHub();
  await evaluate(h, NOW + 11 * MINUTE);

  expect(await pairing(h)).toEqual([
    ['laptop-1', true],
    ['server-1', true],
  ]);
});

test('an unpaired System keeps its last seen and its Timeline', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  await evaluate(h, NOW + 11 * MINUTE);
  await unpair(h.db.sql, 'laptop-1');
  await evaluate(h, NOW + 12 * MINUTE);

  const [laptop] = await listSystems(h.db.sql);

  expect(laptop?.lastSeenAt).toBe(NOW);
  expect(laptop?.timeline.map((l) => [l.condition, l.kind])).toEqual([
    ['system_stale', 'cleared'],
    ['system_stale', 'raised'],
  ]);
});

test('a System unpaired and given a new code stays unpaired until the code is redeemed', async () => {
  await using h = await startHub();
  await unpairedLaptop(h);

  const code = await issue(h, 'laptop-1');

  expect(await pairing(h)).toContainEqual(['laptop-1', false]);

  expect((await redeem(h.hub, { code })).status).toBe(200);

  expect(await pairing(h)).toContainEqual(['laptop-1', true]);
});
