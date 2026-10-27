import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, timeline, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { OLD_EVIDENCE_MS } from './attention-types.ts';
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

  const rows = await readServices(h.db.sql, NOW);
  expect(rows.map(({ name, status, system }) => [system, name, status])).toEqual([
    ['server-1', 'web', 'down'],
    ['server-1', 'api', 'restarted'],
    ['server-1', 'forgotten', 'restarted'],
    ['server-1', 'mixed', 'unknown'],
    ['server-1', 'unchecked', 'unknown'],
    ['server-1', 'unknown', 'unknown'],
    ['laptop-1', 'web', 'unknown'],
  ]);
  expect(rows[0]?.downSince).toBe(NOW - 60_000);
  expect(rows[1]?.latestStopAt).toBe(NOW - 60_000);
  expect(await readServiceAttentionCount(h.db.sql)).toBe(3);

  await unpair(h.db.sql, 'server-1');
  expect((await readServices(h.db.sql, NOW)).map(({ system, name }) => [system, name])).toEqual([
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
  expect((await readServices(h.db.sql, NOW)).map(({ status }) => status)).toEqual([
    'up',
    'unknown',
  ]);
  expect(await readServiceAttentionCount(h.db.sql)).toBe(0);
});

test('quiet or never-heard Systems, or checks old beside Last seen, cannot establish up, but open Service Conditions still win', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', ['web', 'api', 'worker'], {
    services: ['web', 'api', 'worker'].map((service) => ({
      check: 'supervisor',
      detail: 'Running',
      service,
      since: NOW,
      state: 'up',
    })),
  });
  await addCondition(h.db.sql, {
    kind: 'service_down',
    level: 'alert',
    raisedAt: -60,
    subject: 'api',
    system: 'server-1',
  });
  await addCondition(h.db.sql, {
    kind: 'service_restarted',
    level: 'note',
    raisedAt: -60,
    subject: 'worker',
    system: 'server-1',
  });
  expect(
    (await readServices(h.db.sql, NOW + 120_000)).find(({ name }) => name === 'web')?.status,
  ).toBe('up');
  expect(
    (await readServices(h.db.sql, NOW + 120_001)).map(({ name, status }) => [name, status]),
  ).toEqual([
    ['api', 'down'],
    ['worker', 'restarted'],
    ['web', 'unknown'],
  ]);
  // Heard from now, so only the checks' age beside Last seen can make it unknown.
  await h.db.sql`UPDATE systems SET last_seen_at = ${new Date(NOW)} WHERE name = 'server-1'`;
  expect((await readServices(h.db.sql, NOW)).find(({ name }) => name === 'web')?.status).toBe('up');
  await h.db.sql`
    UPDATE check_sets SET received_at = received_at - ${OLD_EVIDENCE_MS + 1} * interval '1 millisecond'
    WHERE system = 'server-1'
  `;
  expect((await readServices(h.db.sql, NOW)).find(({ name }) => name === 'web')?.status).toBe(
    'unknown',
  );
  await h.db.sql`UPDATE systems SET last_seen_at = NULL WHERE name = 'server-1'`;
  expect((await readServices(h.db.sql, NOW)).find(({ name }) => name === 'web')?.status).toBe(
    'unknown',
  );
});

test('forgotten Services remain for either open Condition and disappear after both clear', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', []);
  await hear(h, 'laptop-1', []);
  await Promise.all(
    ['server-1', 'laptop-1'].flatMap((system) => [
      addCondition(h.db.sql, {
        kind: 'service_down',
        level: 'alert',
        raisedAt: -60,
        subject: 'web',
        system,
      }),
      addCondition(h.db.sql, {
        kind: 'service_restarted',
        level: 'note',
        raisedAt: -60,
        subject: 'web',
        system,
      }),
    ]),
  );
  expect(
    (await readServices(h.db.sql, NOW)).map(({ system, name, status }) => [system, name, status]),
  ).toEqual([
    ['laptop-1', 'web', 'down'],
    ['server-1', 'web', 'down'],
  ]);
  expect(await readServiceAttentionCount(h.db.sql)).toBe(2);
  await h.db
    .sql`UPDATE conditions SET cleared_at = ${new Date(NOW)} WHERE kind = 'service_restarted'`;
  expect((await readServices(h.db.sql, NOW)).map(({ status }) => status)).toEqual(['down', 'down']);
  expect(await readServiceAttentionCount(h.db.sql)).toBe(2);
  await h.db.sql`UPDATE conditions SET cleared_at = ${new Date(NOW)} WHERE kind = 'service_down'`;
  expect(await readServices(h.db.sql, NOW)).toEqual([]);
  expect(await readServiceAttentionCount(h.db.sql)).toBe(0);
});

test("reads each Service's latest installed version, and null for one with none", async () => {
  await using h = await startHub();
  const send = (version: string) =>
    push(
      h.hub,
      {
        ...report('server-1', [NOW]),
        records: {
          records: [
            {
              kind: 'application',
              name: 'web-software',
              record: { name: 'web-software', version },
            },
            {
              kind: 'service',
              name: 'web',
              record: {
                application: 'web-software',
                name: 'web',
                supervisor: 'systemd',
                unit: 'web.service',
              },
            },
            {
              kind: 'service',
              name: 'api',
              record: { name: 'api', supervisor: 'systemd', unit: 'api.service' },
            },
          ],
          unreadable: [],
        },
      },
      { token: 'server-token' },
    );
  expect((await send('1.0')).status).toBe(200);
  h.clock.now = NOW + 1000;
  expect((await send('1.1')).status).toBe(200);

  const rows = await readServices(h.db.sql, NOW);

  expect(rows.map(({ name, version }) => [name, version])).toEqual([
    ['api', null],
    ['web', '1.1'],
  ]);
});

const packageObservation = (manager: string, name: string) =>
  JSON.stringify({
    installation: '/',
    manager,
    observedAt: NOW,
    result: {
      kind: 'available',
      metadataAt: NOW,
      updates: [{ available: '3.0', installed: '1.0', name, security: null }],
    },
  });

test('joins the latest upstream and fresh package observations from the Service’s own System', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', ['web', 'package', 'withdrawn', 'invalid']);
  await hear(h, 'laptop-1', ['package']);
  await h.db.sql`DELETE FROM service_versions`;
  await h.db.sql`
    INSERT INTO service_versions (system, service, version, upstream, first_seen_at) VALUES
      ('server-1', 'web', '1.0', 'npm:old', ${new Date(NOW - 1000)}),
      ('server-1', 'web', '1.0', 'github:owner/web', ${new Date(NOW)}),
      ('server-1', 'package', '1.0', 'apt:web', ${new Date(NOW)}),
      ('server-1', 'withdrawn', '1.0', 'brew:web', ${new Date(NOW)}),
      ('server-1', 'invalid', '1.0', 'brew:invalid', ${new Date(NOW)}),
      ('laptop-1', 'package', '1.0', 'apt:web', ${new Date(NOW)})
  `;
  await h.db.sql`
    INSERT INTO upstream_checks (upstream, releases, checked_at, succeeded_at, failure, next_check_at) VALUES
      ('github:owner/web', '{"":"2.0"}', ${new Date(NOW)}, ${new Date(NOW - 1000)}, 'Rate limited', ${new Date(NOW)}),
      ('npm:old', '{"":"9.0"}', ${new Date(NOW)}, ${new Date(NOW)}, null, ${new Date(NOW)})
  `;

  await h.db.sql`
    INSERT INTO update_managers (system, manager, installation, observed_at, observation, withdrawn) VALUES
      ('server-1', 'apt', '/', ${new Date(NOW)}, ${packageObservation('apt', 'web:amd64')}::text::jsonb, false),
      ('server-1', 'homebrew', '/', ${new Date(NOW)}, ${packageObservation('homebrew', 'formula:web')}::text::jsonb, true),
      ('server-1', 'homebrew', '/invalid', ${new Date(NOW)}, '{"bad":"observation"}', false)
  `;
  expect(
    (await readServices(h.db.sql, NOW)).map(({ name, system, update }) => [system, name, update]),
  ).toEqual([
    ['server-1', 'package', '3.0'],
    ['server-1', 'web', '2.0'],
    ['server-1', 'invalid', undefined],
    ['laptop-1', 'package', undefined],
    ['server-1', 'withdrawn', undefined],
  ]);
});
