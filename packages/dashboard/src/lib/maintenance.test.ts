import { describe, expect, test } from 'bun:test';

import type {
  MaintenancePackage,
  MaintenanceServiceUpdate,
  MaintenanceSystem,
} from '../server/maintenance-types.ts';
import {
  maintenanceSummary,
  orderMaintenance,
  PACKAGES_SHOWN,
  splitPackages,
  upstreamName,
} from './maintenance.ts';

const pkg = (name: string, security = false): MaintenancePackage => ({
  available: '2',
  installed: '1',
  manager: 'apt',
  name,
  security,
  securitySince: security ? 1 : null,
});

const update = (name: string): MaintenanceServiceUpdate => ({
  available: '2',
  installed: '1',
  name,
  since: undefined,
  upstream: null,
});

const system = (name: string, over: Partial<MaintenanceSystem> = {}): MaintenanceSystem => ({
  checkedAt: undefined,
  managers: ['apt'],
  packages: [],
  rebootSince: undefined,
  system: name,
  updates: [],
  ...over,
});

describe('orderMaintenance', () => {
  test('orders Systems by security count, then package count, then a pending reboot, then name, and each System packages security first', () => {
    const ordered = orderMaintenance([
      system('c-up-to-date'),
      system('b-many', { packages: [pkg('a'), pkg('b'), pkg('c')] }),
      system('a-security', { packages: [pkg('x'), pkg('s', true)] }),
      system('d-reboot', { rebootSince: 1 }),
      system('e-few', { packages: [pkg('a')] }),
    ]);

    expect(ordered.map(({ system: name }) => name)).toEqual([
      'a-security',
      'b-many',
      'e-few',
      'd-reboot',
      'c-up-to-date',
    ]);
    expect(ordered[0]?.packages.map(({ name }) => name)).toEqual(['s', 'x']);
  });
});

describe('splitPackages', () => {
  test('shows the first few, and every security update even past them, leaving the rest behind "more"', () => {
    const secure = Array.from({ length: PACKAGES_SHOWN + 2 }, (_, i) => pkg(`s${String(i)}`, true));
    expect(splitPackages([pkg('plain'), ...secure])).toEqual({
      more: [pkg('plain')],
      shown: secure,
    });
    const plain = Array.from({ length: PACKAGES_SHOWN + 1 }, (_, i) => pkg(`p${String(i)}`));
    expect(splitPackages(plain).shown).toHaveLength(PACKAGES_SHOWN);
    expect(splitPackages(plain).more).toHaveLength(1);
  });
});

describe('maintenanceSummary', () => {
  test('counts package updates, the security ones, Systems, reboots, and Service updates', () => {
    expect(
      maintenanceSummary([
        system('a', {
          packages: [pkg('x', true), pkg('y')],
          rebootSince: 1,
          updates: [update('w')],
        }),
        system('b', { packages: [pkg('z')] }),
        system('c'),
      ]),
    ).toBe(
      '3 package updates on 2 Systems, 1 of them security. 1 reboot pending. 1 Service update available.',
    );
  });

  test('says so when nothing is pending', () => {
    expect(maintenanceSummary([system('a')])).toBe('Every System is up to date.');
    expect(maintenanceSummary([])).toBe('No paired System.');
  });
});

describe('upstreamName', () => {
  test('names the upstream by its source', () => {
    expect(upstreamName('github:owner/repo')).toBe('GitHub');
    expect(upstreamName('npm:pkg')).toBe('npm');
    expect(upstreamName('oci:ghcr.io/x')).toBe('OCI');
    expect(upstreamName('apt:caddy')).toBe('APT');
    expect(upstreamName('brew:node')).toBe('Homebrew');
    expect(upstreamName(null)).toBeUndefined();
  });
});
