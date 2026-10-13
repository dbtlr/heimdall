import { expect, test } from 'bun:test';

import { unpair } from './pairing.ts';
import { listSystems } from './store.ts';
import { evaluateSystemConditions, SYSTEM_CONDITION_THRESHOLDS } from './system-conditions.ts';
import { issue, NOW, page, push, redeem, report, startHub } from './testing/hub.ts';
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

test('an unpaired System is absent from the normal page, which links to the unpaired view', async () => {
  await using h = await startHub();
  await unpairedLaptop(h);

  const html = await page(h.hub);

  expect(html).toContain('server-1');
  expect(html).not.toContain('laptop-1');
  expect(html).toContain('<a href="/?unpaired">Show 1 unpaired System</a>');
});

test('the link counts the unpaired Systems and is plural for several', async () => {
  await using h = await startHub();
  await unpairedLaptop(h);
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await unpair(h.db.sql, 'server-1');

  expect(await page(h.hub)).toContain('Show 2 unpaired Systems</a>');
});

test('the page has no link while every System is paired', async () => {
  await using h = await startHub();
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });

  const html = await page(h.hub);

  expect(html).not.toContain('unpaired');
  expect(html).not.toContain('Unpaired');
});

test('a paired System with no Report yet does not count as unpaired', async () => {
  await using h = await startHub();
  await evaluate(h, NOW + 11 * MINUTE);
  await evaluate(h, NOW + 12 * MINUTE);

  const html = await page(h.hub);

  expect(html).toContain('Never seen');
  expect(html).not.toMatch(/Show \d+ unpaired/u);
  expect(await page(h.hub, '/?unpaired')).not.toContain('Never seen');
});

test('the unpaired view lists them as Unpaired with their Vitals, Last seen, and Timeline', async () => {
  await using h = await startHub();
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  await evaluate(h, NOW + 11 * MINUTE);
  await unpair(h.db.sql, 'laptop-1');
  await evaluate(h, NOW + 12 * MINUTE);
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });

  const html = await page(h.hub, '/?unpaired');

  expect(html).toContain('laptop-1');
  expect(html).not.toContain('server-1');
  expect(html).toContain('<td><strong>Unpaired</strong></td>');
  expect(html).toContain('2026-10-06 12:00:00 UTC');
  expect(html).toContain('0.1.0 darwin/arm64');
  expect(html).toContain('System stale');
  expect(html).toContain('System heard from again');
  expect(html).toContain('<a href="/">');
});

test('the normal view says no System is paired when Systems exist and none is paired', async () => {
  await using h = await startHub();
  await unpairedLaptop(h);
  await unpair(h.db.sql, 'server-1');

  const html = await page(h.hub);

  expect(html).toContain('No System is paired.');
  expect(html).not.toContain('No System has reported yet.');
  expect(html).toContain('Show 2 unpaired Systems</a>');
});

test('the unpaired view says so when no System is unpaired', async () => {
  await using h = await startHub();

  expect(await page(h.hub, '/?unpaired')).toContain('No System is unpaired.');
});

test('pairing a System again brings it back to the normal view', async () => {
  await using h = await startHub();
  await unpairedLaptop(h);

  const code = await issue(h, 'laptop-1');
  expect((await redeem(h.hub, { code })).status).toBe(200);

  const html = await page(h.hub);
  expect(html).toContain('laptop-1');
  expect(html).not.toContain('unpaired');
  expect(await page(h.hub, '/?unpaired')).not.toContain('laptop-1');
});

test('a System unpaired and given a new code stays hidden until the code is redeemed', async () => {
  await using h = await startHub();
  await unpairedLaptop(h);

  const code = await issue(h, 'laptop-1');

  expect(await page(h.hub)).not.toContain('laptop-1');

  expect((await redeem(h.hub, { code })).status).toBe(200);

  expect(await page(h.hub)).toContain('laptop-1');
});

test('the unpaired page view shows whatever the value of unpaired', async () => {
  await using h = await startHub();
  await unpairedLaptop(h);

  expect(await page(h.hub, '/?unpaired=')).toContain('laptop-1');
  expect(await page(h.hub, '/?unpaired=anything')).toContain('laptop-1');
});

test('listSystems still holds an unpaired System and marks which Systems are paired', async () => {
  await using h = await startHub();
  await unpairedLaptop(h);

  const found = await listSystems(h.db.sql);

  expect(found.map((s) => [s.name, s.paired])).toEqual([
    ['laptop-1', false],
    ['server-1', true],
  ]);
});
