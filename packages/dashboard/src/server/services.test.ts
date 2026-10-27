import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { readServiceAttentionCount, readServices } from './services.ts';

beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const { addCondition } = timeline(NOW);
const hear = async (h: Hub, system: string, names: string[], checks?: Record<string, unknown>) => {
  const response = await push(
    h.hub,
    {
      ...report(system, [NOW]),
      checks,
      records: {
        records: names.map((name) => ({
          kind: 'service',
          name,
          record: { name, supervisor: 'systemd', unit: `${name}.service` },
        })),
        unreadable: [],
      },
    },
    { token: `${system.split('-')[0]}-token` },
  );
  expect(response.status).toBe(200);
};

test('lists paired recorded Services, with down before restarted and missing checks unknown', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', ['web', 'api', 'unchecked', 'mixed', 'unknown'], {
    services: [
      {
        check: 'supervisor',
        detail: 'Observed supervisor or health state',
        service: 'web',
        since: NOW,
        state: 'up',
      },
      {
        check: 'supervisor',
        detail: 'Observed supervisor or health state',
        service: 'api',
        since: NOW,
        state: 'up',
      },
      {
        check: 'supervisor',
        detail: 'Observed supervisor or health state',
        service: 'mixed',
        since: NOW,
        state: 'up',
      },
      {
        check: 'health',
        detail: 'Observed supervisor or health state',
        service: 'mixed',
        since: NOW,
        state: 'down',
      },
      {
        check: 'supervisor',
        detail: 'Observed supervisor or health state',
        service: 'unknown',
        since: NOW,
        state: 'unknown',
      },
    ],
  });
  await hear(h, 'laptop-1', ['web']);
  await Promise.all(
    ['api', 'web', 'forgotten'].map((subject) =>
      addCondition(h.db.sql, {
        kind: 'service_restarted',
        level: 'note',
        raisedAt: -120,
        subject,
        system: 'server-1',
      }),
    ),
  );
  await addCondition(h.db.sql, {
    kind: 'service_down',
    level: 'alert',
    raisedAt: -60,
    subject: 'web',
    system: 'server-1',
  });
  await addCondition(h.db.sql, {
    clearedAt: -100,
    kind: 'service_down',
    level: 'alert',
    raisedAt: -300,
    subject: 'api',
    system: 'server-1',
  });
  await h.db
    .sql`INSERT INTO service_stops (system, service, stopped_at, started_at, ongoing, restarts, sent_at, received_at)
    VALUES ('server-1', 'api', ${new Date(NOW - 120_000)}, ${new Date(NOW - 110_000)}, false, 1, ${new Date(NOW)}, ${new Date(NOW)}),
           ('server-1', 'api', ${new Date(NOW - 60_000)}, ${new Date(NOW - 50_000)}, false, 1, ${new Date(NOW)}, ${new Date(NOW)})`;

  const rows = await readServices(h.db.sql);
  expect(rows.map(({ name, status, system }) => [system, name, status])).toEqual([
    ['server-1', 'web', 'down'],
    ['server-1', 'api', 'restarted'],
    ['server-1', 'mixed', 'unknown'],
    ['server-1', 'unchecked', 'unknown'],
    ['server-1', 'unknown', 'unknown'],
    ['laptop-1', 'web', 'unknown'],
  ]);
  expect(rows[0]?.downSince).toBe(NOW - 60_000);
  expect(rows[1]?.latestStopAt).toBe(NOW - 60_000);
  expect(await readServiceAttentionCount(h.db.sql)).toBe(2);

  await unpair(h.db.sql, 'server-1');
  expect((await readServices(h.db.sql)).map(({ system, name }) => [system, name])).toEqual([
    ['laptop-1', 'web'],
  ]);
  expect(await readServiceAttentionCount(h.db.sql)).toBe(0);
});

test('up requires all held checks to pass; a System with no check set still lists its Service', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', ['web'], {
    services: [
      {
        check: 'supervisor',
        detail: 'Observed supervisor or health state',
        service: 'web',
        since: NOW,
        state: 'up',
      },
      {
        check: 'health',
        detail: 'Observed supervisor or health state',
        service: 'web',
        since: NOW,
        state: 'up',
      },
    ],
  });
  await hear(h, 'laptop-1', ['web']);
  expect((await readServices(h.db.sql)).map(({ status }) => status)).toEqual(['up', 'unknown']);
  expect(await readServiceAttentionCount(h.db.sql)).toBe(0);
});
