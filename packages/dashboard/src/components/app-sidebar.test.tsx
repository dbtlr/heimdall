import { describe, expect, test } from 'bun:test';

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';

import { systemSearch } from '../lib/system-search.ts';
import type { Attention } from '../server/attention-types.ts';
import type { FleetGlance, SystemGlance } from '../server/fleet-overview-types.ts';
import { ServiceAttentionCount } from './app-navigation.tsx';
import { AppSidebar } from './app-sidebar.tsx';

const NOW = 10_000_000;

const lane = (name: string, over: Partial<SystemGlance> = {}): SystemGlance => ({
  lastSeenAt: NOW - 20_000,
  latest: {
    cpuBusyPercent: 12,
    disks: [{ mount: '/', totalBytes: 100, usedBytes: 40 }],
    memoryUsedPercent: 41,
    t: NOW - 20_000,
  },
  name,
  silencedUntil: undefined,
  sleeps: false,
  status: 'up',
  ...over,
});

const alert = (system: string): Attention => ({
  checkedAt: NOW,
  conditionId: `c-${system}`,
  disk: undefined,
  evidence: 'current',
  firstDetected: 100,
  kind: 'low_disk',
  level: 'alert',
  reason: '97% used',
  subject: '/',
  system,
  unpaired: false,
});

const glance: FleetGlance = {
  attention: [alert('zeta-1')],
  deliveryFailingSince: undefined,
  lanes: [lane('alpha-1'), lane('zeta-1', { status: 'needs_you' })],
  now: NOW,
  unpairedCount: 1,
  unpairedLanes: [lane('old-1', { status: 'unpaired' })],
};

// The sidebar at `path`, inside a router that has a System route with the
// search of the System page.
const render = async (
  path: string,
  count = 0,
  shown: { glance: FleetGlance | undefined } = { glance },
) => {
  const root = createRootRoute({
    component: () => (
      <ServiceAttentionCount value={count}>
        <AppSidebar glance={shown.glance} />
        <Outlet />
      </ServiceAttentionCount>
    ),
  });
  const system = createRoute({
    getParentRoute: () => root,
    path: '/systems/$name',
    validateSearch: systemSearch,
  });
  const others = ['/', '/services', '/agents', '/timeline', '/compare'].map((routePath) =>
    createRoute({ getParentRoute: () => root, path: routePath }),
  );
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: root.addChildren([system, ...others]),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
};

describe('the sidebar', () => {
  test('lists the paired Systems in tile order under Fleet, then the unpaired ones last', async () => {
    const html = await render('/');

    const order = ['zeta-1', 'alpha-1', 'old-1'].map((name) =>
      html.indexOf(`href="/systems/${name}"`),
    );
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(html.indexOf('Fleet')).toBeLessThan(order[0] ?? 0);
    expect(html.indexOf('href="/services"')).toBeGreaterThan(order[2] ?? 0);
    expect(html).toContain('2 Systems');
    expect(html).toContain('aria-label="old-1: Unpaired"');
    expect(html).toContain('>Unpaired<');
  });

  test('a System row links plainly off a System page and has no current row', async () => {
    const html = await render('/services');

    expect(html).toContain('href="/systems/alpha-1"');
    expect(html).not.toContain('/systems/alpha-1?');
    expect(html).not.toMatch(/aria-current="page"[^>]*href="\/systems/);
  });

  test('on a System page the row is current, keeps tab and range, and Fleet is not the current page', async () => {
    const html = await render('/systems/alpha-1?range=7d&tab=sessions');

    expect(html).toContain('href="/systems/zeta-1?range=7d&amp;tab=sessions"');
    const current = html.match(/<a\b[^>]*aria-current="page"[^>]*>/gu) ?? [];
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/systems/alpha-1?range=7d&amp;tab=sessions"');
    expect(current[0]).toMatch(/[" ]bg-accent[" ]/u);
    const fleet = /<a\b[^>]*href="\/"[^>]*>/u.exec(html)?.[0] ?? '';
    expect(fleet).toContain('font-semibold');
    expect(fleet).not.toMatch(/[" ]bg-accent[" ]/u);
  });

  test('a System row shows the worst problem or Healthy', async () => {
    const html = await render('/');

    expect(html).toContain('Low disk');
    expect(html).toContain('Healthy');
  });

  test('on Compare Fleet is the current page; a viewed unpaired System is the current row', async () => {
    const compare = await render('/compare');
    const unpaired = await render('/systems/old-1?range=12h&tab=now');

    expect(/<a\b[^>]*href="\/"[^>]*>/u.exec(compare)?.[0]).toContain('aria-current="page"');
    const current = unpaired.match(/<a\b[^>]*aria-current="page"[^>]*>/gu) ?? [];
    expect(current).toHaveLength(1);
    expect(current[0]).toContain('href="/systems/old-1');
  });

  test('the verdict shows once a paired System has reported, as on the Fleet page', async () => {
    const reported = await render('/');
    const silent = await render('/', 0, {
      glance: {
        ...glance,
        lanes: [
          lane('alpha-1', { lastSeenAt: undefined }),
          lane('zeta-1', { lastSeenAt: undefined, status: 'needs_you' }),
        ],
      },
    });

    expect(reported).toContain('aria-label="1 alert"');
    expect(silent).not.toContain('aria-label="1 alert"');
  });

  test('without a glance it shows the destinations and no Systems', async () => {
    const html = await render('/', 0, { glance: undefined });

    for (const href of ['/', '/services', '/agents', '/timeline']) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).not.toContain('href="/systems/');
    expect(html).not.toContain('Systems</span>');
  });

  for (const count of [0, 3]) {
    test(`the Services badge ${count === 0 ? 'hides at zero' : 'shows the attention count'}`, async () => {
      const html = await render('/', count);

      expect(html.includes('3 Services down or restarted')).toBe(count > 0);
    });
  }
});
