import { describe, expect, test } from 'bun:test';

import { PACKAGES_SHOWN } from '../lib/maintenance.ts';
import type { MaintenancePackage, MaintenanceSystem } from '../server/maintenance-types.ts';
import { MaintenanceCards } from './maintenance-cards.tsx';
import { linksIn, renderRouted } from './render-routed.tsx';

const DAY = 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;

const pkg = (name: string, security = false): MaintenancePackage => ({
  available: '3.0.15-1',
  installed: '3.0.13-1',
  manager: 'APT',
  name,
  security,
  securitySince: security ? NOW - 2 * DAY : null,
});

const system = (name: string, over: Partial<MaintenanceSystem> = {}): MaintenanceSystem => ({
  checkedAt: undefined,
  managers: ['APT'],
  packages: [],
  rebootSince: undefined,
  system: name,
  updates: [],
  ...over,
});

const render = (systems: MaintenanceSystem[]) =>
  renderRouted(<MaintenanceCards maintenance={{ now: NOW, systems }} />, {
    routePaths: ['/systems/$name'],
  });

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

  test('packages past the first few wait behind a "+N more" expander', async () => {
    const html = await render([
      system('server-1', {
        packages: Array.from({ length: PACKAGES_SHOWN + 3 }, (_, i) => pkg(`pkg-${String(i)}`)),
      }),
    ]);

    expect(html).toContain('+3 more');
    expect(html).toContain('<details');
  });

  test('a System with nothing pending is a quiet card saying when it was last checked, and one never checked says so', async () => {
    const html = await render([
      system('mini-1', { checkedAt: NOW - 40 * 60_000 }),
      system('mini-2'),
    ]);

    expect(html).toContain('Up to date. Checked 40 min ago.');
    expect(html).toContain('Up to date. Not checked yet.');
    expect(html).not.toContain('Packages');
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
