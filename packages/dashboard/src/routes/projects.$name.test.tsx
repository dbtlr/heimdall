import { afterAll, beforeAll, expect, mock, test } from 'bun:test';

import { NOW, startHub, timeline } from '@heimdall/hub/testing';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { SQL } from 'bun';
import { renderToStaticMarkup } from 'react-dom/server';

import { getProjectView } from '../server/project-view-fn.ts';
import { readProjectPage } from '../server/project-view.ts';
import type { Route as AppRoot } from './__root.tsx';

type RootData = (typeof AppRoot)['types']['loaderData'];

// The database the page's server function reads: each test's own Hub.
let database: SQL | undefined;

beforeAll(async () => {
  await mock.module('../server/project-view-fn.ts', () => ({
    getProjectView: ({ data }: { data: { name: string; range: '30d'; timeZone: string } }) => {
      if (database === undefined) {
        throw new Error('No test Hub');
      }
      return readProjectPage(database, { ...data, now: NOW });
    },
  }));
});

afterAll(async () => {
  await mock.module('../server/project-view-fn.ts', () => ({ getProjectView }));
});

// The page's real route, loader included, under a bare root. The path carries
// the search the page fills in, since the router redirects a path without it.
const renderAt = async (path: string) => {
  const { Route } = await import('./projects.$name.tsx');
  // A bare root with the app root's loader type, which the page's route types expect.
  const root = createRootRoute({
    component: Outlet,
    loader: async (): Promise<RootData> => {
      await Promise.resolve();
      return { count: 0, fleet: undefined, hubVersion: undefined };
    },
  });
  const { component, loader, loaderDeps, notFoundComponent, validateSearch } = Route.options;
  if (
    component === undefined ||
    loader === undefined ||
    loaderDeps === undefined ||
    notFoundComponent === undefined ||
    validateSearch === undefined
  ) {
    throw new Error('The project route lost an option this test mounts.');
  }
  const route = createRoute({
    component,
    getParentRoute: () => root,
    loader,
    loaderDeps,
    notFoundComponent,
    path: '/projects/$name',
    validateSearch,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [`${path}?by=harness&range=30d`] }),
    routeTree: root.addChildren([route]),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
};

const seeded = async () => {
  const h = await startHub();
  await h.db.sql`INSERT INTO systems (name) VALUES ('laptop-1')`;
  await timeline(NOW).addSession(h.db.sql, {
    firstCwd: '/repos/notes-app',
    id: 'one',
    requests: [-60],
  });
  database = h.db.sql;
  return h;
};

test('an unknown project reaches the page’s not-found, not an error', async () => {
  await using _h = await seeded();
  const html = await renderAt('/projects/unknown');
  expect(html).toContain('The Hub holds no such project.');
  expect(html).not.toContain('Something went wrong');
});

test('a known project opens its page', async () => {
  await using _h = await seeded();
  const html = await renderAt('/projects/notes-app');
  expect(html).toContain('>notes-app</h1>');
  expect(html).not.toContain('no such project');
});
