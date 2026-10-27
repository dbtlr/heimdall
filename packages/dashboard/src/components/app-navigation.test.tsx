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

import { AppNavigation, ServiceAttentionCount } from './app-navigation.tsx';

for (const [path, active] of [
  ['/', 'Fleet'],
  ['/agents', 'Agents'],
  ['/services', 'Services'],
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
    const children = ['/', '/services', '/agents', '/timeline', '/compare', '/systems/$name'].map(
      (routePath) => createRoute({ getParentRoute: () => root, path: routePath }),
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
    expect(html).toMatch(
      new RegExp(`aria-current="page"[^>]*>(?:(?!</a>).)*${active}(?:(?!</a>).)*</a>`),
    );
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
  expect(tabs).toHaveLength(4);
  for (const tab of tabs) {
    expect(tab).toMatch(/^<svg\b[^>]*aria-hidden="true"/);
  }
});

for (const count of [0, 3]) {
  test(`Services navigation badge ${count === 0 ? 'hides at zero' : 'shows the attention count'}`, async () => {
    const root = createRootRoute({
      component: () => (
        <ServiceAttentionCount value={count}>
          <AppNavigation />
        </ServiceAttentionCount>
      ),
    });
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ['/'] }),
      routeTree: root,
    });
    await router.load();
    const html = renderToStaticMarkup(<RouterProvider router={router} />);
    expect(html.includes('<span class="sr-only">3 Services down or restarted</span>')).toBe(
      count > 0,
    );
    if (count > 0) {
      expect(html).toMatch(/<span aria-hidden="true"[^>]*>3<\/span>/u);
    }
    expect(html).toContain('href="/services"');
  });
}
