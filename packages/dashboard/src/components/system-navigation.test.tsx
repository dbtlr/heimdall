import { expect, test } from 'bun:test';

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
import { SystemNavigationHeader } from './system-navigation.tsx';

test('System chips show at every width and keep the tab and range between Systems but drop a System-specific sample', async () => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => (
      <SystemNavigationHeader
        current="server-1"
        range="7d"
        tab="sessions"
        systems={[
          { level: undefined, name: 'laptop-1', status: 'up' },
          { level: 'alert', name: 'server-1', status: 'needs_you' },
        ]}
      />
    ),
    getParentRoute: () => root,
    path: '/systems/$name',
    validateSearch: systemSearch,
  });
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: ['/systems/server-1?range=7d&tab=sessions&at=1234'],
    }),
    routeTree: root.addChildren([route]),
  });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain('href="/systems"');
  expect(html).toMatch(/<nav aria-label="Systems" class="(?![^"]*hidden)[^"]*">/u);
  expect(html).toContain('href="/systems/laptop-1?range=7d&amp;tab=sessions"');
  expect(html).toContain('aria-label="server-1: Alert"');
  expect(html).toContain('aria-label="System views"');
  expect(html).toContain('tab=vitals');
  expect(html).toContain('at=1234');
});

// The header for server-1 on `tab`, rendered to markup.
const renderHeader = async (tab: 'now' | 'records' | 'timeline'): Promise<string> => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => (
      <SystemNavigationHeader
        current="server-1"
        range="12h"
        systems={[{ level: undefined, name: 'server-1', status: 'up' }]}
        tab={tab}
      />
    ),
    getParentRoute: () => root,
    path: '/systems/$name',
    validateSearch: systemSearch,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [`/systems/server-1?range=12h&tab=${tab}`] }),
    routeTree: root.addChildren([route]),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
};

test('the desktop range picker shows on the overview and not on Records or Timeline, which the range does not change', async () => {
  expect(await renderHeader('now')).toContain('aria-label="Range"');
  expect(await renderHeader('records')).not.toContain('aria-label="Range"');
  expect(await renderHeader('timeline')).not.toContain('aria-label="Range"');
});
