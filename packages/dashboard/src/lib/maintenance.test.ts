import { describe, expect, test } from 'bun:test';

import type {
  MaintenanceCheck,
  MaintenancePackage,
  MaintenanceServiceUpdate,
  MaintenanceSystem,
} from '../server/maintenance-types.ts';
import {
  checkSentence,
  maintenanceSummary,
  orderMaintenance,
  PACKAGES_SHOWN,
  pendingCheckNote,
  splitPackages,
  upstreamName,
  withoutServicePackages,
} from './maintenance.ts';

const pkg = (name: string, security = false): MaintenancePackage => ({
  available: '2',
  cask: false,
  installed: '1',
  label: name,
  manager: 'apt',
  name,
  security,
  securitySince: security ? 1 : null,
});

// A Homebrew package by its full identity, such as `cask:zoom`.
const brew = (name: string): MaintenancePackage => {
  const [kind = '', label = ''] = name.split(':');
  return { ...pkg(name), cask: kind === 'cask', label };
};

const update = (name: string): MaintenanceServiceUpdate => ({
  available: '2',
  installed: '1',
  name,
  security: false,
  since: undefined,
  upstream: null,
});

const CHECKED: MaintenanceCheck = { at: 0, kind: 'current' };

const system = (name: string, over: Partial<MaintenanceSystem> = {}): MaintenanceSystem => ({
  check: CHECKED,
  managers: ['apt'],
  packages: [],
  rebootSince: undefined,
  system: name,
  updates: [],
  ...over,
});

describe('orderMaintenance', () => {
  test('orders Systems by security count, then package count, then a pending reboot, then Service updates, then name', () => {
    const ordered = orderMaintenance([
      system('c-up-to-date'),
      system('b-many', { packages: [pkg('a'), pkg('b'), pkg('c')] }),
      system('a-security', { packages: [pkg('x'), pkg('s', true)] }),
      system('d-reboot', { rebootSince: 1 }),
      system('e-few', { packages: [pkg('a')] }),
      system('f-service', { updates: [update('w')] }),
      system('g-services', { updates: [update('w'), update('v')] }),
    ]);

    expect(ordered.map(({ system: name }) => name)).toEqual([
      'a-security',
      'b-many',
      'e-few',
      'd-reboot',
      'g-services',
      'f-service',
      'c-up-to-date',
    ]);
  });

  test('puts an up to date System after one with only a Service update, and after one whose checks cannot show it is up to date', () => {
    const ordered = orderMaintenance([
      system('a-up-to-date'),
      system('b-unchecked', { check: { kind: 'none' } }),
      system('c-service', { updates: [update('w')] }),
    ]);

    expect(ordered.map(({ system: name }) => name)).toEqual([
      'c-service',
      'b-unchecked',
      'a-up-to-date',
    ]);
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

  test('orders packages by the name shown, so Homebrew casks fall among formulas', () => {
    const { shown } = splitPackages(
      ['formula:git', 'cask:zoom', 'formula:act', 'cask:bat-app', 'formula:curl'].map(brew),
    );

    expect(shown.map(({ label }) => label)).toEqual(['act', 'bat-app', 'curl', 'git', 'zoom']);
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

  test('never calls the fleet up to date while a System has no current package check', () => {
    expect(maintenanceSummary([system('a'), system('b', { check: { kind: 'none' } })])).toBe(
      'No update is known to be pending. 1 System has no current package check.',
    );
    expect(
      maintenanceSummary([
        system('a', { packages: [pkg('x')] }),
        system('b', { check: { kind: 'failed', manager: 'APT', reason: 'no indexes' } }),
        system('c', { check: { at: 0, kind: 'old', manager: 'APT' } }),
      ]),
    ).toBe('1 package update on 1 System. 2 Systems have no current package check.');
  });
});

describe('checkSentence', () => {
  const NOW = 10 * 86_400_000;

  test('calls a System up to date only on a current check, and otherwise says why its checks cannot show it', () => {
    expect(checkSentence({ at: NOW - 40 * 60_000, kind: 'current' }, NOW)).toBe(
      'Up to date. Checked 40 min ago.',
    );
    expect(checkSentence({ kind: 'none' }, NOW)).toBe(
      'Not known to be up to date: no package check has reported.',
    );
    expect(
      checkSentence(
        { kind: 'failed', manager: 'APT', reason: 'APT has no local package indexes.' },
        NOW,
      ),
    ).toBe('Not known to be up to date: the APT check failed (APT has no local package indexes).');
    expect(checkSentence({ at: NOW - 3 * 86_400_000, kind: 'old', manager: 'APT' }, NOW)).toBe(
      'Not known to be up to date: APT was last checked 3 d ago.',
    );
    expect(
      checkSentence({ at: NOW - 9 * 86_400_000, kind: 'metadata', manager: 'Homebrew' }, NOW),
    ).toBe("Not known to be up to date: Homebrew's package metadata is 9 d old.");
    expect(checkSentence({ at: null, kind: 'metadata', manager: 'Homebrew' }, NOW)).toBe(
      "Not known to be up to date: Homebrew's package metadata is of unknown age.",
    );
    expect(checkSentence({ kind: 'unreadable', manager: 'Homebrew' }, NOW)).toBe(
      'Not known to be up to date: the Homebrew check was stored in a form this page cannot read.',
    );
  });
});

describe('pendingCheckNote', () => {
  const NOW = 10 * 86_400_000;

  test('says nothing of a current check, and otherwise that the list may be out of date and why', () => {
    expect(pendingCheckNote({ at: NOW - 40 * 60_000, kind: 'current' }, NOW)).toBeUndefined();
    expect(pendingCheckNote({ kind: 'failed', manager: 'APT', reason: 'apt timed out' }, NOW)).toBe(
      'What is listed may be out of date: the APT check failed (apt timed out).',
    );
    expect(pendingCheckNote({ at: NOW - 3 * 86_400_000, kind: 'old', manager: 'APT' }, NOW)).toBe(
      'What is listed may be out of date: APT was last checked 3 d ago.',
    );
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

describe('withoutServicePackages', () => {
  test('a package of a Service on an apt: or brew: upstream is counted once, as the Service update', () => {
    const apt = { ...pkg('caddy:amd64'), manager: 'APT' };
    const brew = { ...pkg('formula:ntfy'), manager: 'Homebrew' };
    const other = pkg('curl:amd64');
    const held = system('server-1', {
      packages: [apt, brew, other],
      updates: [
        { ...update('caddy'), upstream: 'apt:caddy' },
        { ...update('ntfy'), upstream: 'brew:ntfy' },
        { ...update('web'), upstream: 'github:owner/web' },
      ],
    });
    const kept = withoutServicePackages(held);
    expect(kept.packages).toEqual([other]);
    expect(kept.updates).toEqual(held.updates);
    expect(maintenanceSummary([kept])).toBe(
      '1 package update on 1 System. 3 Service updates available.',
    );
  });

  test("a Service's package that is a security update keeps its System's security count and order", () => {
    const server = withoutServicePackages(
      system('server-1', {
        packages: [pkg('caddy:amd64', true)],
        updates: [{ ...update('web'), upstream: 'apt:caddy' }],
      }),
    );
    const laptop = system('laptop-1', { packages: [pkg('curl:amd64')] });
    expect(server.updates.map(({ security }) => security)).toEqual([true]);
    expect(maintenanceSummary([server, laptop])).toBe(
      '1 package update on 1 System. 1 Service update available, 1 of them security.',
    );
    expect(orderMaintenance([laptop, server]).map(({ system: name }) => name)).toEqual([
      'server-1',
      'laptop-1',
    ]);
  });
});
