import { createRouter, ErrorComponent } from '@tanstack/react-router';

import { routeTree } from './routeTree.gen.ts';

// Start calls this for every request on the server, and once in the browser.
// A failed read shows its error inside the route that read it, so the layout,
// its navigation and refresh, and the update watcher in the shell stay up, and
// the next refresh can replace the error. Without a default, an error rises to
// the router's own boundary outside the shell and replaces the whole page.
export const getRouter = () =>
  createRouter({ defaultErrorComponent: ErrorComponent, routeTree, scrollRestoration: true });
