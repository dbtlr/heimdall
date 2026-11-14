import { describe, expect, test } from 'bun:test';

import { PACKAGES_SHOWN } from '../lib/maintenance.ts';
import type { MaintenancePackage, MaintenanceSystem } from '../server/maintenance-types.ts';
import { MaintenanceCards } from './maintenance-cards.tsx';
import { linksIn, renderRouted } from './render-routed.tsx';

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;

const pkg = (name: string, security = false): MaintenancePackage => ({
  available: '3.0.15-1',
  cask: false,
  installed: '3.0.13-1',
  label: name,
  manager: 'APT',
  name,
  security,
  securitySince: security ? NOW - 2 * DAY : null,
});

const system = (name: string, over: Partial<MaintenanceSystem> = {}): MaintenanceSystem => ({
  check: { at: NOW - 40 * 60_000, kind: 'current' },
  managers: ['APT'],
  packages: [],
  rebootSince: undefined,
  system: name,
  updates: [],
  ...over,
});

const render = (systems: MaintenanceSystem[]) =>
  renderRouted(<MaintenanceCards maintenance={{ now: NOW, systems }} />);

describe('the Maintenance cards', () => {
  test('a card names its System and manager, the pending reboot with its age, security packages first with versions and since, and a Service update with its upstream', async () => {
    const html = await render([
      system('server-1', {
        packages: [pkg('curl'), pkg('openssl', true)],
        rebootSince: NOW - 4 * DAY,
        updates: [
          {
            available: '2.9.1',
            installed: '2.8.4',
            name: 'caddy',
            since: NOW - 5 * DAY,
            upstream: 'github:example/caddy',
          },
        ],
      }),
    ]);

    expect(linksIn(html).find(({ label }) => label === 'server-1')?.href).toBe('/systems/server-1');
    expect(html).toContain('Reboot pending · 4 d');
    expect(html).toContain('Packages 2 · 1 security');
    expect(html.indexOf('openssl')).toBeLessThan(html.indexOf('curl'));
    expect(html).toContain('3.0.13-1');
    expect(html).toContain('3.0.15-1');
    expect(html).toContain('since 2 d');
    expect(html).toContain('caddy');
    expect(html).toContain('2.8.4');
    expect(html).toContain('2.9.1');
    expect(html).toContain('found 5 d ago · GitHub');
  });

  test('a package reads by its short name, keeps its full identity as a title, and a cask is marked', async () => {
    const html = await render([
      system('workstation-1', {
        managers: ['Homebrew'],
        packages: [
          { ...pkg('formula:wget'), label: 'wget', manager: 'Homebrew' },
          { ...pkg('cask:firefox'), cask: true, label: 'firefox', manager: 'Homebrew' },
        ],
      }),
    ]);

    expect(html).toContain('title="formula:wget">wget<');
    expect(html).toMatch(/title="cask:firefox">firefox<span[^>]*>cask<\/span>/u);
    expect(html).not.toMatch(/title="formula:wget">wget<span/u);
    expect(html).not.toContain('>formula:wget<');
  });

  test('packages past the first few wait behind a "+N more" expander', async () => {
    const html = await render([
      system('server-1', {
        packages: Array.from({ length: PACKAGES_SHOWN + 3 }, (_, i) => pkg(`pkg-${String(i)}`)),
      }),
    ]);

    expect(html).toContain('+3 more');
    expect(html).toContain('<details');
  });

  test('a System with nothing pending and a current check is a quiet card saying when it was last checked', async () => {
    const html = await render([system('mini-1')]);

    expect(html).toContain('Up to date. Checked 40 min ago.');
    expect(html).toContain('opacity-80');
    expect(html).not.toContain('Packages');
  });

  test('a System whose check failed or never reported is not called up to date, nor quiet', async () => {
    const html = await render([
      system('mini-1', {
        check: { kind: 'failed', manager: 'APT', reason: 'APT has no local package indexes' },
      }),
      system('mini-2', { check: { kind: 'none' } }),
    ]);

    expect(html).not.toContain('Up to date');
    expect(html).not.toContain('opacity-80');
    expect(html).toContain(
      'Not known to be up to date: the APT check failed (APT has no local package indexes).',
    );
    expect(html).toContain('Not known to be up to date: no package check has reported.');
    expect(html).toContain('2 Systems have no current package check.');
  });

  test('a System with something pending under a check that is not current says its list may be out of date, and why', async () => {
    const html = await render([
      system('server-1', {
        check: { kind: 'failed', manager: 'APT', reason: 'apt timed out' },
        packages: [pkg('curl')],
        rebootSince: NOW - 4 * DAY,
      }),
      system('laptop-1', { packages: [pkg('git')] }),
    ]);

    expect(html).toContain(
      'What is listed may be out of date: the APT check failed (apt timed out).',
    );
    // Only server-1's card says so; laptop-1's check is current.
    expect(html.split('may be out of date')).toHaveLength(2);
    expect(html.indexOf('may be out of date')).toBeLessThan(html.indexOf('laptop-1'));
    expect(html).toContain('1 System has no current package check.');
  });

  test('a System whose only pending item is a reboot is not called up to date', async () => {
    const html = await render([system('server-1', { rebootSince: NOW - 4 * DAY })]);

    expect(html).toContain('Reboot pending · 4 d');
    expect(html).not.toContain('Up to date');
    expect(html).not.toContain('opacity-80');
  });

  test('the summary leads, and the cards keep the order they are given', async () => {
    const html = await render([
      system('b-1', { packages: [pkg('x', true)] }),
      system('a-1', { packages: [pkg('y')] }),
    ]);

    expect(html).toContain('2 package updates on 2 Systems, 1 of them security.');
    expect(html.indexOf('b-1')).toBeLessThan(html.indexOf('a-1'));
  });
});
