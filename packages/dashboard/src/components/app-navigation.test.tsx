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

import { AppNavigation } from './app-navigation.tsx';

for (const [path, active] of [
  ['/', 'Fleet'],
  ['/agents', 'Agents'],
  ['/timeline', 'Timeline'],
  ['/compare', 'Fleet'],
  ['/systems/server-1', 'Fleet'],
]) {
  test(`phone navigation marks ${active} on ${path}`, async () => {
    const root = createRootRoute({
      component: () => (
        <>
          <AppNavigation />
          <Outlet />
        </>
      ),
    });
    const children = ['/', '/agents', '/timeline', '/compare', '/systems/$name'].map((routePath) =>
      createRoute({ getParentRoute: () => root, path: routePath }),
    );
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: [path ?? '/'] }),
      routeTree: root.addChildren(children),
    });
    await router.load();
    const html = renderToStaticMarkup(<RouterProvider router={router} />);
    expect(html).toContain('aria-label="Main navigation"');
    expect(html).toContain('href="/agents"');
    expect(html).toContain('href="/timeline"');
    expect(html).toMatch(new RegExp(`aria-current="page"[^>]*>(?:(?!</a>).)*${active}</a>`));
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });
}

test('phone navigation gives every tab an icon that screen readers skip', async () => {
  const root = createRootRoute({ component: AppNavigation });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: root,
  });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  const tabs = [...html.matchAll(/<a\b[^>]*>(.*?)<\/a>/g)].map((match) => match[1] ?? '');
  expect(tabs).toHaveLength(3);
  for (const tab of tabs) {
    expect(tab).toMatch(/^<svg\b[^>]*aria-hidden="true"/);
  }
});
