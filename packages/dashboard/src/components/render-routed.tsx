import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// A test helper: the markup of `element` rendered where links can resolve,
// inside a router whose only route is the root.
export const renderRouted = async (element: ReactNode): Promise<string> => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: createRootRoute({ component: () => element }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
};
