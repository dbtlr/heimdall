import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';

import { ROUTER_OPTIONS } from './router-options.ts';

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
// oxlint-disable-next-line promise/avoid-new -- Browsers expose timers through callbacks.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  await tick();
  await tick();
  await tick();
};

// A page whose read starts failing, as a refresh does while the server
// restarts, keeps the layout around its error, and recovers on the next read.
async function run() {
  let failing = false;
  const root = createRootRoute({
    component: () => (
      <>
        <nav>layout</nav>
        <Outlet />
      </>
    ),
  });
  const page = createRoute({
    component: () => <p>page</p>,
    getParentRoute: () => root,
    loader: () => {
      if (failing) {
        throw new TypeError('Failed to fetch');
      }
      return null;
    },
    path: '/',
  });
  const router = createRouter({
    ...ROUTER_OPTIONS,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: root.addChildren([page]),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  try {
    await router.load();
    reactRoot.render(<RouterProvider router={router} />);
    await settle();
    assert(container.textContent === 'layoutpage', `Loaded: ${container.textContent}`);

    failing = true;
    await router.invalidate();
    await settle();
    const text = container.textContent ?? '';
    assert(text.startsWith('layout'), `The layout stays around a failed read: ${text}`);
    assert(text.includes('Something went wrong!'), `The error shows in the page: ${text}`);

    failing = false;
    await router.invalidate();
    await settle();
    assert(
      container.textContent === 'layoutpage',
      `The next read recovers: ${container.textContent}`,
    );
  } finally {
    reactRoot.unmount();
    container.remove();
  }
}

try {
  await run();
  document.body.textContent = 'Router error DOM tests passed';
} catch (error) {
  document.body.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
}
