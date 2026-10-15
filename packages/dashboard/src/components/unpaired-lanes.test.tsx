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

import { UnpairedLink } from './unpaired-lanes.tsx';

test('Compare returns to Fleet when its empty unpaired view says Back to Fleet', async () => {
  const root = createRootRoute({ component: Outlet });
  const compare = createRoute({
    component: () => <UnpairedLink count={0} shown />,
    getParentRoute: () => root,
    path: '/compare',
  });
  const fleet = createRoute({ getParentRoute: () => root, path: '/' });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/compare?unpaired=true'] }),
    routeTree: root.addChildren([compare, fleet]),
  });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain('href="/"');
  expect(html).toContain('Back to Fleet');
});
