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

test('System navigation keeps the tab and range between Systems but drops a System-specific sample', async () => {
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
  expect(html).toContain('href="/"');
  expect(html).toContain('href="/systems/laptop-1?range=7d&amp;tab=sessions"');
  expect(html).toContain('aria-label="server-1: Alert"');
  expect(html).toContain('aria-label="System views"');
  expect(html).toContain('tab=vitals');
  expect(html).toContain('at=1234');
});
