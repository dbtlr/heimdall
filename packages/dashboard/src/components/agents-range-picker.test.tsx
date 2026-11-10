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

import { agentsSearch } from '../lib/agents-search.ts';
import { AgentsRangePicker } from './agents-range-picker.tsx';

test('Agents period links preserve the viewer zone and breakdown and drop the pick', async () => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => <AgentsRangePicker current="7d" />,
    getParentRoute: () => root,
    path: '/agents',
    validateSearch: agentsSearch,
  });
  const router = createRouter({
    history: createMemoryHistory({
      initialEntries: ['/agents?range=7d&by=model&zone=Europe%2FBerlin&pick=heimdall'],
    }),
    routeTree: root.addChildren([route]),
  });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain('href="/agents?range=today&amp;by=model&amp;zone=Europe%2FBerlin"');
  expect(html).toContain('href="/agents?range=30d&amp;by=model&amp;zone=Europe%2FBerlin"');
  expect(html).not.toContain('pick=');
  expect(html).toContain('Today');
  expect(html).toContain('7 days');
  expect(html).toContain('30 days');
});
