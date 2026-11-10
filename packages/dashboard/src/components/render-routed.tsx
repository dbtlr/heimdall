import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// A test helper: the markup of `element` rendered where links can resolve,
// inside a router at `path`: one whose only route is the root, or with
// `routePaths`, one where those routes, each rendering nothing, sit under it.
export const renderRouted = async (
  element: ReactNode,
  { path = '/', routePaths = [] }: { path?: string; routePaths?: readonly string[] } = {},
): Promise<string> => {
  const leaf = createRootRoute({ component: () => element });
  const root = createRootRoute({
    component: () => (
      <>
        {element}
        <Outlet />
      </>
    ),
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree:
      routePaths.length === 0
        ? leaf
        : root.addChildren(
            routePaths.map((routePath) =>
              createRoute({ getParentRoute: () => root, path: routePath }),
            ),
          ),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
};

// The links in `html`: where each leads, its text, whether it is marked as the
// current page, and whether it opens with an icon screen readers skip.
export const linksIn = (html: string) =>
  [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gu)].map(([, attributes = '', content = '']) => ({
    current: attributes.includes('aria-current="page"'),
    href: /href="([^"]*)"/u.exec(attributes)?.[1]?.replaceAll('&amp;', '&'),
    icon: /^<svg\b[^>]*aria-hidden="true"/u.test(content),
    label: content.replaceAll(/<[^>]*>/gu, ''),
  }));
