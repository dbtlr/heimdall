/* oxlint-disable node/no-sync -- React flushSync commits DOM updates before assertions. */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { servicesSearch } from '../lib/services.ts';
import type { ServiceFilters, ServiceSummary } from '../lib/services.ts';
import { ActiveServiceFilters, ServicesFilters } from './service-filters.tsx';

const rows: ServiceSummary[] = [
  { downSince: 0, latestStopAt: undefined, name: 'web', status: 'down', system: 'alpha' },
  { downSince: undefined, latestStopAt: undefined, name: 'api', status: 'up', system: 'beta' },
];

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
const button = (name: string) => {
  const found = [...document.querySelectorAll('button')].find(
    (element) =>
      (element.getAttribute('aria-label') ??
        (element.hasAttribute('aria-haspopup') ? 'Filter' : element.textContent.trim())) === name,
  );
  if (found === undefined) {
    throw new Error(`Missing button: ${name}`);
  }
  return found;
};
const click = (name: string) => flushSync(() => button(name).click());
// oxlint-disable-next-line promise/avoid-new -- Browsers expose timers through callbacks.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  await tick();
  await tick();
};

async function run() {
  const root = createRootRoute();
  const route = createRoute({
    component: function component() {
      const search = route.useSearch();
      const navigate = route.useNavigate();
      const filters = { status: search.status ?? [], system: search.system ?? [] };
      const change = (next: ServiceFilters) => {
        void navigate({ search: servicesSearch(next) });
      };
      return (
        <>
          <ServicesFilters filters={filters} onChange={change} rows={rows} />
          <ActiveServiceFilters filters={filters} onChange={change} />
        </>
      );
    },
    getParentRoute: () => root,
    path: '/services',
    validateSearch: servicesSearch,
  });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/services'] }),
    routeTree: root.addChildren([route]),
  });
  await router.load();
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(<RouterProvider router={router} />));
  const dialog = document.querySelector('dialog');
  if (dialog === null) {
    throw new Error('Missing dialog');
  }
  const url = () => router.state.location.href;

  try {
    assert(!dialog.open, 'Sheet starts closed');
    click('Filter');
    assert(dialog.open, 'Filter opens the native modal');
    click('Down, 1 Services');
    assert(
      button('Down, 1 Services').getAttribute('aria-pressed') === 'true',
      'Chip updates draft',
    );
    button('Show 1 Services');
    assert(url() === '/services', 'Draft leaves URL unchanged');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    await settle();
    assert(!dialog.open && url() === '/services', 'Escape discards draft');
    click('Filter');
    assert(
      button('Down, 1 Services').getAttribute('aria-pressed') === 'false',
      'Reopen resets discarded draft',
    );
    button('Show 2 Services');
    click('Up, 1 Services');
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -1, clientY: -1 }));
    await settle();
    assert(!dialog.open && url() === '/services', 'Backdrop discards draft');
    click('Filter');
    click('Down, 1 Services');
    click('alpha, 1 Services');
    click('Show 1 Services');
    await settle();
    assert(!dialog.open, 'Show closes sheet');
    assert(
      JSON.stringify(router.state.location.search) ===
        JSON.stringify({ status: ['down'], system: ['alpha'] }),
      'Show applies both sections to URL',
    );
    click('Filter');
    assert(
      button('Down, 1 Services').getAttribute('aria-pressed') === 'true',
      'Reopen reads applied status',
    );
    assert(
      button('alpha, 1 Services').getAttribute('aria-pressed') === 'true',
      'Reopen reads applied System',
    );
    click('Clear all');
    button('Show 2 Services');
    assert(url().includes('status='), 'Clear all changes only draft');
    click('Show 2 Services');
    await settle();
    assert(url() === '/services', 'Applying Clear all omits both URL params');
    const clear = async (action: string) => {
      click('Filter');
      click('Down, 1 Services');
      click('Show 1 Services');
      await settle();
      click(action);
      await settle();
      assert(url() === '/services', `${action} removes the final URL param`);
    };
    await clear('Clear');
    await clear('Remove Down filter');
    await router.navigate({ search: { system: ['alpha'] }, to: '/services' });
    await settle();
    click('Remove alpha filter');
    await settle();
    assert(url() === '/services', 'Removing the last System pill omits its URL param');
  } finally {
    flushSync(() => reactRoot.unmount());
    container.remove();
  }
}

try {
  await run();
  document.body.textContent = 'Service filter DOM tests passed';
} catch (error) {
  document.body.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
}
