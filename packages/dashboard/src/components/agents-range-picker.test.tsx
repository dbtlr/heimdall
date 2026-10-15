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
import { AppHeader } from './app-header.tsx';

test('Agents period links preserve the viewer zone and Fleet navigation remains available', async () => {
  const root = createRootRoute({ component: Outlet });
  const route = createRoute({
    component: () => (
      <AppHeader>
        <AgentsRangePicker current="7d" />
      </AppHeader>
    ),
    getParentRoute: () => root,
    path: '/agents',
    validateSearch: agentsSearch,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/agents?range=7d&zone=Europe%2FBerlin'] }),
    routeTree: root.addChildren([route]),
  });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain('href="/"');
  expect(html).toContain('>Agents</a>');
  expect(html).toMatch(/<a(?=[^>]*href="\/agents")(?=[^>]*aria-current="page")[^>]*>/u);
  expect(html).toContain('href="/agents?range=today&amp;zone=Europe%2FBerlin"');
  expect(html).toContain('href="/agents?range=30d&amp;zone=Europe%2FBerlin"');
  expect(html).toContain('Today');
  expect(html).toContain('7 days');
  expect(html).toContain('30 days');
});
