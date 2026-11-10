import { describe, expect, test } from 'bun:test';

import type { Attention } from '../server/attention-types.ts';
import { maintenanceCard, pendingPackages } from './home-maintenance.ts';

const DAY = 24 * 60 * 60_000;
const NOW = 100 * DAY;

const condition = (
  kind: 'pending_update' | 'reboot_required',
  system: string,
  over: Partial<Attention> = {},
): Attention =>
  ({
    checkedAt: NOW,
    conditionId: `${kind}-${system}`,
    evidence: 'current',
    firstDetected: NOW - DAY,
    kind,
    level: 'note',
    reason: kind,
    subject: kind === 'pending_update' ? JSON.stringify(['apt', 'system']) : '',
    system,
    unpaired: false,
    ...over,
  }) as Attention;

// The packages the Hub holds as pending in one source on `system`.
const held = (
  system: string,
  manager: string,
  installation: string,
  packages: number,
  security: number,
) => ({
  installation,
  manager,
  packages,
  security,
  system,
});

describe('pendingPackages', () => {
  test("counts each open Pending update's source, at any level, with its security packages, and links the System to its fullest source", () => {
    const brew = condition('pending_update', 'laptop-1', {
      conditionId: 'brew',
      level: 'warning',
      subject: JSON.stringify(['homebrew', '/opt/homebrew']),
    });
    const counts = pendingPackages(
      [condition('pending_update', 'server-1'), condition('pending_update', 'laptop-1'), brew],
      [
        held('server-1', 'apt', 'system', 3, 1),
        held('laptop-1', 'apt', 'system', 1, 0),
        held('laptop-1', 'homebrew', '/opt/homebrew', 2, 2),
        // A source no open Condition names is not counted.
        held('server-1', 'homebrew', '/usr/local', 1, 1),
      ],
    );

    expect(counts).toEqual([
      { conditionId: 'brew', packages: 3, security: 2, system: 'laptop-1' },
      { conditionId: 'pending_update-server-1', packages: 3, security: 1, system: 'server-1' },
    ]);
  });

  test('an unpaired System, and a System whose Condition is not open, are not counted', () => {
    const apt = held('server-1', 'apt', 'system', 1, 1);

    expect(pendingPackages([], [apt])).toEqual([]);
    expect(
      pendingPackages([condition('pending_update', 'server-1', { unpaired: true })], [apt]),
    ).toEqual([]);
  });
});

const update = (name: string, since: number | undefined) => ({
  name,
  since,
  system: 'server-1',
  version: '2.0',
});

describe('maintenanceCard', () => {
  test('the rows say the packages and Systems, the reboots and the oldest, and the Service whose update waited longest', () => {
    const card = maintenanceCard(
      {
        attention: [
          condition('reboot_required', 'server-1', { firstDetected: NOW - 2 * DAY }),
          condition('reboot_required', 'db-1', { firstDetected: NOW - 6 * DAY, level: 'warning' }),
          condition('reboot_required', 'gone-1', { unpaired: true }),
        ],
        packages: [
          { conditionId: 'a', packages: 30, security: 10, system: 'server-1' },
          { conditionId: 'b', packages: 8, security: 4, system: 'db-1' },
        ],
        updates: [update('web', NOW - DAY), update('ntfy', NOW - 5 * DAY), update('db', undefined)],
      },
      NOW,
    );

    expect(card.packages).toEqual({
      security: 14,
      systems: [
        { conditionId: 'a', packages: 30, security: 10, system: 'server-1' },
        { conditionId: 'b', packages: 8, security: 4, system: 'db-1' },
      ],
      text: '38 packages on 2 Systems',
    });
    expect(card.reboots).toEqual({
      oldest: 'oldest 6 d',
      systems: [
        { conditionId: 'reboot_required-db-1', system: 'db-1' },
        { conditionId: 'reboot_required-server-1', system: 'server-1' },
      ],
      text: '2 Systems need a reboot',
    });
    expect(card.updates).toEqual({ longest: 'ntfy 5 d', text: '3 Services have an update' });
  });

  test('one of each reads in the singular, and an update no release dates names only its Service', () => {
    const card = maintenanceCard(
      {
        attention: [condition('reboot_required', 'server-1', { firstDetected: NOW - 3 * DAY })],
        packages: [{ conditionId: 'a', packages: 1, security: 0, system: 'server-1' }],
        updates: [update('db', undefined)],
      },
      NOW,
    );

    expect(card.packages?.text).toBe('1 package on 1 System');
    expect(card.reboots).toMatchObject({ oldest: 'open 3 d', text: '1 System needs a reboot' });
    expect(card.updates).toEqual({ longest: 'db', text: '1 Service has an update' });
  });

  test('a row with nothing is omitted', () => {
    expect(maintenanceCard({ attention: [], packages: [], updates: [] }, NOW)).toEqual({
      packages: undefined,
      reboots: undefined,
      updates: undefined,
    });
  });
});
