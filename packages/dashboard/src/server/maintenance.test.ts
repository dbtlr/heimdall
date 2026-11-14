import { beforeAll, expect, test } from 'bun:test';

import { NOW, push, report, startHub, storeToken, unpair } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';
import type { UpdateManager } from '@heimdall/schema';

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
// `pending` (or reporting `result` instead), any `sources` beside it, and a
// reboot marker, as a Collector sends them.
const hear = async (
  h: Hub,
  system: string,
  pending: Pending[],
  {
    reboot = false,
    result,
    services = [],
    sources = [],
  }: {
    reboot?: boolean;
    result?: UpdateManager['result'];
    services?: string[];
    sources?: UpdateManager[];
  } = {},
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
            result: result ?? {
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
          ...sources,
        ],
        reboot: { kind: 'available', observedAt: NOW - 20 * MINUTE, required: reboot },
      },
    },
    { token: `${system.split('-')[0] ?? system}-token` },
  );
  expect(response.status).toBe(200);
};

test("reads each paired System's pending packages with their security, its pending reboot, and Service updates dated by their upstream, and leaves out an unpaired System", async () => {
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
  expect(
    server?.packages
      .map(({ name, security, securitySince }) => [name, security, securitySince])
      .toSorted(),
  ).toEqual([
    ['curl', false, null],
    ['openssl', true, NOW],
  ]);
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
  expect(mini).toMatchObject({
    check: { at: NOW - 20 * MINUTE, kind: 'current' },
    packages: [],
    updates: [],
  });
});

test('a System whose package check failed, read old metadata, or never reported has no current check', async () => {
  await using h = await startHub();
  await storeToken(h.db.sql, { pairedAt: NOW, system: 'quiet-1', token: 'quiet-token' });
  await hear(h, 'server-1', [], {
    result: { kind: 'unavailable', reason: 'APT has no local package indexes' },
  });
  await hear(h, 'laptop-1', [], {
    result: { kind: 'available', metadataAt: NOW - 8 * DAY, updates: [] },
  });

  const checkOf = async (name: string, now = NOW) =>
    (await readMaintenance(h.db.sql, now)).systems.find(({ system }) => system === name)?.check;

  expect(await checkOf('server-1')).toEqual({
    kind: 'failed',
    manager: 'APT',
    reason: 'APT has no local package indexes',
  });
  expect(await checkOf('laptop-1')).toEqual({
    at: NOW - 8 * DAY,
    kind: 'metadata',
    manager: 'APT',
  });
  expect(await checkOf('quiet-1')).toEqual({ kind: 'none' });
  // A day on, the last check is too old to show anything.
  expect(await checkOf('server-1', NOW + DAY)).toEqual({
    at: NOW - 20 * MINUTE,
    kind: 'old',
    manager: 'APT',
  });
});

// A package source checked as the Collector checks APT in `hear`, reporting
// `result`.
const source = (
  manager: UpdateManager['manager'],
  installation: string,
  result: UpdateManager['result'],
): UpdateManager => ({ installation, manager, observedAt: NOW - 20 * MINUTE, result });

const CURRENT: UpdateManager['result'] = {
  kind: 'available',
  metadataAt: NOW - 2 * HOUR,
  updates: [],
};

test('a System with several package sources has a current check only when every one of them is current', async () => {
  await using h = await startHub();
  await storeToken(h.db.sql, { pairedAt: NOW, system: 'mini-1', token: 'mini-token' });
  await hear(h, 'server-1', [], {
    sources: [
      source('homebrew', '/opt/homebrew', { kind: 'unavailable', reason: 'brew timed out' }),
    ],
  });
  await hear(h, 'laptop-1', [], {
    sources: [
      source('homebrew', '/opt/homebrew', CURRENT),
      source('homebrew', '/usr/local', {
        kind: 'available',
        metadataAt: NOW - 8 * DAY,
        updates: [],
      }),
    ],
  });
  await hear(h, 'mini-1', [], { sources: [source('homebrew', '/opt/homebrew', CURRENT)] });

  const checks = new Map(
    (await readMaintenance(h.db.sql, NOW)).systems.map(({ check, system }) => [system, check]),
  );

  // APT, sorted first, is current; Homebrew's failure still decides.
  expect(checks.get('server-1')).toEqual({
    kind: 'failed',
    manager: 'Homebrew',
    reason: 'brew timed out',
  });
  // One Homebrew installation is current, the other read old metadata.
  expect(checks.get('laptop-1')).toEqual({
    at: NOW - 8 * DAY,
    kind: 'metadata',
    manager: 'Homebrew',
  });
  expect(checks.get('mini-1')).toEqual({ at: NOW - 20 * MINUTE, kind: 'current' });
});

test('a malformed package observation leaves its source with no current check and every other System intact', async () => {
  await using h = await startHub();
  await hear(h, 'server-1', [{ name: 'openssl:amd64', security: true }]);
  await hear(h, 'laptop-1', [], { sources: [source('homebrew', '/opt/homebrew', CURRENT)] });
  await h.db.sql`
    UPDATE update_managers SET observation = '{"manager":"homebrew"}'::jsonb
    WHERE system = 'laptop-1' AND manager = 'homebrew'
  `;

  const { systems } = await readMaintenance(h.db.sql, NOW);
  const byName = new Map(systems.map((s) => [s.system, s]));

  expect(byName.get('laptop-1')?.check).toEqual({ kind: 'unreadable', manager: 'Homebrew' });
  expect(byName.get('server-1')?.check).toEqual({ at: NOW - 20 * MINUTE, kind: 'current' });
  expect(byName.get('server-1')?.packages).toHaveLength(1);
});

test("a package reads by its short name with its full identity kept, and an APT architecture is dropped when it is the System's own", async () => {
  await using h = await startHub();
  await hear(h, 'server-1', [
    { name: 'openssl:amd64', security: null },
    { name: 'bash:amd64', security: null },
    { name: 'libc6:i386', security: null },
  ]);

  const [system] = (await readMaintenance(h.db.sql, NOW)).systems;
  const labels = system?.packages.map(({ label, name }) => [name, label]);

  expect(labels?.toSorted()).toEqual([
    ['bash:amd64', 'bash'],
    ['libc6:i386', 'libc6:i386'],
    ['openssl:amd64', 'openssl'],
  ]);
});
