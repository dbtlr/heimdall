import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';

import { FINISH_MS, SHOW_AFTER_MS } from '../lib/navigation-progress.ts';
import { ROUTER_OPTIONS } from '../router-options.ts';
import { NavigationProgress } from './navigation-progress.tsx';

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
// oxlint-disable-next-line promise/avoid-new -- Browsers expose timers through callbacks.
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A read the test finishes by hand, as a slow page's read finishes in its own time.
const heldRead = () => {
  const { promise, resolve } = Promise.withResolvers<null>();
  return {
    read: promise,
    release: () => {
      resolve(null);
    },
  };
};

// A link inside a page leads to a page that takes a while: the wait shows after
// its delay and clears on arrival. The paths are the app's own, which the
// router's registered types want of a link. A page that is ready at once, and a refresh
// of the page in view, never show it.
async function run() {
  let held = heldRead();
  let slowReads = 0;
  const root = createRootRoute({
    component: () => (
      <NavigationProgress>
        <Outlet />
      </NavigationProgress>
    ),
  });
  const home = createRoute({
    component: () => (
      <p>
        home <Link to="/services">slow</Link> <Link to="/more">quick</Link>
      </p>
    ),
    getParentRoute: () => root,
    path: '/',
  });
  const quick = createRoute({
    component: () => (
      <p>
        quick page <Link to="/services">slow</Link>
      </p>
    ),
    getParentRoute: () => root,
    loader: () => null,
    path: '/more',
  });
  const slow = createRoute({
    component: () => <p>slow page</p>,
    getParentRoute: () => root,
    loader: () => {
      slowReads += 1;
      return held.read;
    },
    path: '/services',
  });
  const router = createRouter({
    ...ROUTER_OPTIONS,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: root.addChildren([home, quick, slow]),
  });
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  const line = () => container.querySelector('[data-navigation-line]');
  const phase = () => line()?.getAttribute('data-navigation-line');
  const page = () => container.querySelector('[aria-busy]');
  const busy = () => page()?.getAttribute('aria-busy');
  const shows = (text: string) => (container.textContent ?? '').includes(text);
  const click = (label: string) => {
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent === label);
    assert(link !== undefined, `No ${label} link in: ${container.textContent}`);
    link?.click();
  };
  // Every phase the line passes through, so a flash between two checks is seen.
  const seen: (string | null)[] = [];
  const observer = new MutationObserver(() => {
    seen.push(phase() ?? null);
  });
  try {
    await router.load();
    reactRoot.render(<RouterProvider router={router} />);
    await wait(SHOW_AFTER_MS * 2);
    assert(phase() === 'idle' && busy() === 'false', `At rest: ${phase()} ${busy()}`);
    observer.observe(container, { attributeFilter: ['data-navigation-line'], subtree: true });

    click('quick');
    await wait(SHOW_AFTER_MS * 2);
    assert(shows('quick page'), 'The quick page arrived.');
    assert(seen.length === 0, `A page ready at once shows nothing: ${seen.join(',')}`);

    click('slow');
    await wait(SHOW_AFTER_MS / 2);
    assert(phase() === 'idle', `Nothing shows before the wait is over: ${phase()}`);
    await wait(SHOW_AFTER_MS);
    assert(phase() === 'loading', `The line shows after the wait: ${phase()}`);
    assert(busy() === 'true', `The page being left is marked busy: ${busy()}`);
    assert(shows('quick page'), `The page being left stays in view: ${container.textContent}`);

    held.release();
    await wait(FINISH_MS / 4);
    assert(shows('slow page'), 'The slow page arrived.');
    assert(phase() === 'done' && busy() === 'false', `On arrival: ${phase()} ${busy()}`);
    await wait(FINISH_MS);
    assert(phase() === 'idle', `The line clears after its finish: ${phase()}`);

    seen.length = 0;
    held = heldRead();
    const before = slowReads;
    void router.invalidate();
    await wait(SHOW_AFTER_MS * 3);
    assert(slowReads === before + 1, `The refresh read the page again: ${slowReads - before}`);
    assert(seen.length === 0, `A refresh of the page in view shows nothing: ${seen.join(',')}`);
    held.release();
    await wait(SHOW_AFTER_MS);
    assert(seen.length === 0, `Nor does its end: ${seen.join(',')}`);
  } finally {
    observer.disconnect();
    reactRoot.unmount();
    container.remove();
  }
}

try {
  await run();
  document.body.textContent = 'Navigation progress DOM tests passed';
} catch (error) {
  document.body.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
}
