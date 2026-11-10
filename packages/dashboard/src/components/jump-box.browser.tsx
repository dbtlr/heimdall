/* oxlint-disable node/no-sync -- React flushSync commits DOM updates before assertions. */
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { JumpIndex } from '../server/jump-index-types.ts';
import { JumpBox } from './jump-box.tsx';

const index: JumpIndex = {
  projects: ['server-tools'],
  services: [{ name: 'server-web', system: 'edge-1' }],
  sessions: [
    {
      harness: 'codex',
      project: 'norn',
      sessionId: '5e7a0c',
      source: 'codex',
      system: 'server-1',
    },
  ],
  systems: ['server-1', 'server-2'],
};

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
};

const press = (target: EventTarget, key: string) =>
  flushSync(() =>
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key })),
  );

// Types into a React-controlled input the way a person does.
const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
const type = (input: HTMLInputElement, value: string) => {
  flushSync(() => {
    // oxlint-disable-next-line typescript/unbound-method -- the prototype's setter, called on the input, bypasses React's value tracking as typing does.
    Reflect.apply(valueSetter?.set ?? (() => undefined), input, [value]);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

async function run() {
  const root = createRootRoute({
    component: () => (
      <>
        <input aria-label="Other field" />
        <JumpBox loadIndex={() => Promise.resolve(index)} shortcut />
        <Outlet />
      </>
    ),
  });
  const paths = [
    '/',
    '/agents',
    '/systems/$name',
    '/systems/$name/services/$service',
    '/systems/$name/sessions/$harness/$source/$sessionId',
  ];
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: root.addChildren(
      paths.map((path) => createRoute({ getParentRoute: () => root, path })),
    ),
  });
  await router.load();
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(<RouterProvider router={router} />));
  const box = document.querySelector<HTMLInputElement>('[role="combobox"]');
  const other = document.querySelector<HTMLInputElement>('[aria-label="Other field"]');
  const list = document.querySelector('[role="listbox"]');
  if (box === null || other === null || list === null) {
    throw new Error('Missing combobox, listbox, or other field');
  }
  const options = () => [...list.querySelectorAll('[role="option"]')];
  const selected = () =>
    options().findIndex((item) => item.getAttribute('aria-selected') === 'true');
  const url = () => router.state.location.href;
  const opens = async (query: string, href: string) => {
    press(document.body, '/');
    await settle();
    type(box, query);
    press(box, 'Enter');
    await settle();
    assert(url() === href, `"${query}" opens ${href}, not ${url()}`);
  };

  try {
    assert(box.getAttribute('aria-controls') === list.id, 'The combobox controls the listbox');
    assert(box.getAttribute('aria-expanded') === 'false', 'The list starts closed');

    other.focus();
    press(other, '/');
    assert(document.activeElement === other, 'A slash typed in another field stays there');

    other.blur();
    const shortcut = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '/' });
    flushSync(() => document.body.dispatchEvent(shortcut));
    await settle();
    assert(document.activeElement === box, 'A slash elsewhere focuses the jump box');
    assert(shortcut.defaultPrevented, 'The slash that focuses the box is not typed into it');
    assert(options().length === 0, 'An empty query lists nothing');

    type(box, 'serv');
    await settle();
    assert(box.getAttribute('aria-expanded') === 'true', 'A matching query opens the list');
    assert(options().length === 4, `Systems, Service, and project match, not ${options().length}`);
    assert(selected() === 0, 'The first result is active');
    assert(
      box.getAttribute('aria-activedescendant') === options()[0]?.id,
      'The combobox points at the active option',
    );

    press(box, 'ArrowDown');
    assert(selected() === 1, 'ArrowDown moves to the next result');
    press(box, 'ArrowUp');
    press(box, 'ArrowUp');
    assert(selected() === 3, 'ArrowUp wraps to the last result');

    type(box, 'zzz');
    assert(box.getAttribute('aria-expanded') === 'false', 'No match closes the list');
    assert(
      document.querySelector('[role="status"]')?.textContent === 'Nothing matches “zzz”.',
      'No match says so',
    );

    press(box, 'Escape');
    assert(document.activeElement !== box, 'Escape leaves the box');
    assert(box.value === '' && options().length === 0, 'Escape clears and closes');

    await opens('server-2', '/systems/server-2');
    assert(box.value === '' && document.activeElement !== box, 'Opening a result closes the box');
    await opens('server-web', '/systems/edge-1/services/server-web');
    await opens('tools', '/agents?by=project&pick=server-tools&range=30d');
    await opens('5e7', '/systems/server-1/sessions/codex/codex/5e7a0c');

    // As the top bar hides the box below its breakpoint.
    const shown = box.parentElement;
    if (shown === null) {
      throw new Error('The jump box has no container');
    }
    shown.style.display = 'none';
    const slash = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '/' });
    flushSync(() => document.body.dispatchEvent(slash));
    assert(!slash.defaultPrevented, 'A slash with the box hidden is left to the browser');
    assert(document.activeElement !== box, 'A slash focuses no hidden box');
    shown.style.display = '';
  } finally {
    flushSync(() => reactRoot.unmount());
    container.remove();
  }
}

try {
  await run();
  document.body.textContent = 'Jump box DOM tests passed';
} catch (error) {
  document.body.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
}
