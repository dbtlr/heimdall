import { expect, test } from 'bun:test';

import { hubStatusRecorder } from './hub-status.ts';
import { startHub } from './testing/hub.ts';

test('records startup and each completed timer pass using the supplied clock', async () => {
  await using h = await startHub();
  let now = 1_800_000_000_000;
  const status = hubStatusRecorder({ now: () => now, sql: h.db.sql, warn: () => {} });
  await status.start({ deliveryConfigured: true, version: 'test-version' });
  now += 1234;
  for (const pass of [
    'prune',
    'conditions',
    'delivery',
    'parse',
    'refresh',
    'listening',
    'upstreams',
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- exercise each pass against the same row.
    await status.pass(pass, async () => {});
  }
  const [row] = await h.db.sql`SELECT * FROM hub_status`;
  expect(row.version).toBe('test-version');
  expect(row.started_at.getTime()).toBe(1_800_000_000_000);
  expect(row.delivery_configured).toBe(true);
  expect(row.last_runs).toEqual({
    conditions: now,
    delivery: now,
    listening: now,
    parse: now,
    prune: now,
    refresh: now,
    upstreams: now,
  });
  await status.start({ deliveryConfigured: false, version: 'next' });
  const [restarted] = await h.db.sql`SELECT * FROM hub_status`;
  expect(restarted.last_runs).toEqual({});
});

test('a failed status write warns without failing startup or a timer pass', async () => {
  await using h = await startHub();
  await h.db.sql`DROP TABLE hub_status`;
  const warnings: string[] = [];
  const status = hubStatusRecorder({
    now: () => 123,
    sql: h.db.sql,
    warn: (s) => {
      warnings.push(s);
    },
  });
  await status.start({ deliveryConfigured: false, version: 'test' });
  let ran = false;
  await status.pass('prune', async () => {
    ran = true;
  });
  expect(ran).toBe(true);
  expect(warnings).toHaveLength(2);
  expect(
    status.pass('parse', async () => {
      throw new Error('pass failed');
    }),
  ).rejects.toThrow('pass failed');
});
