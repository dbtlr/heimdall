import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, storeToken, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { readMaintenance } from './maintenance.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const at = (ms: number) => new Date(ms);

type Pending = { name: string; security: boolean | null };

// One Report from `system` received at NOW, with an APT source holding
// `pending` and a reboot marker, as a Collector sends them.
const hear = async (
  h: Hub,
  system: string,
  pending: Pending[],
  { reboot = false, services = [] }: { reboot?: boolean; services?: string[] } = {},
) => {
  h.clock.now = NOW;
  const response = await push(
    h.hub,
    {
      ...report(system, [NOW]),
      records: {
        records: services.map((name) => ({
          kind: 'service',
          name,
          record: { name, supervisor: 'systemd', unit: `${name}.service` },
        })),
        unreadable: [],
      },
      updates: {
        managers: [
          {
            installation: 'system',
            manager: 'apt',
            observedAt: NOW - 20 * MINUTE,
            result: {
              kind: 'available',
              metadataAt: NOW - 2 * HOUR,
              updates: pending.map(({ name, security }) => ({
                available: '2',
                installed: '1',
                name,
                security,
              })),
            },
          },
        ],
        reboot: { kind: 'available', observedAt: NOW - 20 * MINUTE, required: reboot },
      },
    },
    { token: `${system.split('-')[0] ?? system}-token` },
  );
  expect(response.status).toBe(200);
};

test("reads each paired System's pending packages security first, its pending reboot, and Service updates dated by their upstream, and leaves out an unpaired System", async () => {
  await using h = await startHub();
  await storeToken(h.db.sql, { pairedAt: NOW, system: 'mini-1', token: 'mini-token' });
  await storeToken(h.db.sql, { pairedAt: NOW, system: 'old-1', token: 'old-token' });
  await hear(
    h,
    'server-1',
    [
      { name: 'curl', security: false },
      { name: 'openssl', security: true },
    ],
    { reboot: true, services: ['web'] },
  );
  await hear(h, 'laptop-1', [{ name: 'git', security: null }]);
  await hear(h, 'mini-1', []);
  await hear(h, 'old-1', [{ name: 'tzdata', security: false }]);
  await unpair(h.db.sql, 'old-1');
  await h.db.sql`DELETE FROM service_versions`;
  await h.db.sql`
    INSERT INTO service_versions (system, service, version, upstream, first_seen_at)
    VALUES ('server-1', 'web', '1.0', 'github:owner/web', ${at(NOW - 10 * DAY)})
  `;
  await h.db.sql`
    INSERT INTO upstream_checks (upstream, releases, checked_at, succeeded_at, next_check_at)
    VALUES ('github:owner/web', '{"":"2.0"}', ${at(NOW)}, ${at(NOW)}, ${at(NOW + HOUR)})
  `;
  await h.db.sql`
    INSERT INTO upstream_releases (upstream, version, first_found_at)
    VALUES ('github:owner/web', '2.0', ${at(NOW - 5 * DAY)})
  `;

  const { systems } = await readMaintenance(h.db.sql, NOW);

  expect(systems.map(({ system }) => system)).toEqual(['server-1', 'laptop-1', 'mini-1']);
  const [server, laptop, mini] = systems;
  expect(server?.packages.map(({ name, security }) => [name, security])).toEqual([
    ['openssl', true],
    ['curl', false],
  ]);
  expect(server?.packages[0]?.securitySince).toBe(NOW);
  expect(server?.managers).toEqual(['APT']);
  expect(server?.rebootSince).toBe(NOW);
  expect(server?.updates).toEqual([
    {
      available: '2.0',
      installed: '1.0',
      name: 'web',
      since: NOW - 5 * DAY,
      upstream: 'github:owner/web',
    },
  ]);
  expect(laptop?.packages).toHaveLength(1);
  expect(laptop?.rebootSince).toBeUndefined();
  // An up to date System says when it was last checked.
  expect(mini).toMatchObject({ checkedAt: NOW - 20 * MINUTE, packages: [], updates: [] });
});
