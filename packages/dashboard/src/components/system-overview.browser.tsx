/* oxlint-disable node/no-sync -- React flushSync commits DOM updates before assertions. */
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { SampleInspection, SystemDetail } from '../server/system-detail-types.ts';
import { SystemOverview } from './system-overview.tsx';

const MINUTE = 60_000;
const GIB = 1024 ** 3;
const NOW = 1_800_000_000_000;
const FROM = NOW - 12 * 60 * MINUTE;

const detail: SystemDetail = {
  changes: [],
  collectorVersion: '1.0.0',
  conditions: [],
  cpu: [{ average: 20, high: 30, low: 10, t: NOW - 5 * MINUTE }],
  from: FROM,
  gaps: [],
  harnesses: [],
  lastSeenAt: NOW,
  latest: undefined,
  limitPercent: undefined,
  load: [],
  memory: [],
  name: 'server-1',
  now: NOW,
  paired: true,
  platform: { arch: 'x64', os: 'linux' },
  processes: [],
  range: '12h',
  sessions: [],
  silencedUntil: undefined,
  sleeps: false,
  status: 'up',
  to: NOW,
};

const inspected = (t: number): SampleInspection => ({
  bucket: undefined,
  cpuBusyPercent: 20,
  load1: 1,
  memoryHolders: undefined,
  memoryTotalBytes: 16 * GIB,
  memoryUsedBytes: 4 * GIB,
  processes: [],
  t,
  unlinked: [],
});

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};
// oxlint-disable-next-line promise/avoid-new -- Browsers expose timers through callbacks.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// Every time the overview asked to pin, as the route's `at` would take it.
const pinned: number[] = [];

// The overview with the pinned sample held as the route holds `at`.
function Page() {
  const [at, setAt] = useState<number | undefined>();
  return (
    <SystemOverview
      attention={[]}
      detail={detail}
      failed={false}
      loading={false}
      onSelect={(t) => {
        pinned.push(t);
        setAt(t);
      }}
      recorded={{ applications: [], files: [], jobs: [], services: [] }}
      sample={at === undefined ? null : inspected(at)}
    />
  );
}

async function run() {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: createRootRoute({ component: Page }),
  });
  await router.load();
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(<RouterProvider router={router} />));
  await tick();
  const sliders = document.querySelectorAll<HTMLElement>('[role="slider"]');
  const [slider] = sliders;
  if (sliders.length !== 1 || slider === undefined) {
    throw new Error('The overview has one time slider');
  }
  const value = (name: string) => slider.getAttribute(name);
  const press = (key: string, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, shiftKey });
    flushSync(() => slider.dispatchEvent(event));
    return event;
  };

  try {
    assert(slider.tabIndex === 0, 'The slider is in the tab order');
    assert(value('aria-label') === 'Pinned sample', 'The slider is named');
    assert(
      value('aria-valuemin') === String(FROM) && value('aria-valuemax') === String(NOW),
      "The slider's range is the window",
    );
    assert(value('aria-valuenow') === String(NOW), 'With none pinned it stands at the newest');
    assert((value('aria-valuetext') ?? '') !== '', 'The slider names the time it stands at');

    slider.focus();
    assert(document.activeElement === slider, 'The slider takes focus');
    const left = press('ArrowLeft');
    assert(left.defaultPrevented, 'An arrow key does not scroll the page');
    assert(
      pinned.at(-1) === NOW - 5 * MINUTE,
      `Left pins a bucket earlier, not ${String(pinned.at(-1))}`,
    );
    assert(value('aria-valuenow') === String(NOW - 5 * MINUTE), 'The slider follows the pin');
    press('ArrowLeft', true);
    assert(pinned.at(-1) === NOW - 65 * MINUTE, 'Shift+Left pins an hour earlier');
    press('ArrowRight');
    assert(pinned.at(-1) === NOW - 60 * MINUTE, 'Right pins a bucket later');
    press('Home');
    assert(pinned.at(-1) === FROM, "Home pins the window's start");
    press('End');
    assert(pinned.at(-1) === NOW, "End pins the window's end");
    const count = pinned.length;
    assert(
      !press('Tab').defaultPrevented && pinned.length === count,
      'Tab leaves the slider alone',
    );
  } finally {
    flushSync(() => reactRoot.unmount());
    container.remove();
  }
}

try {
  await run();
  document.body.textContent = 'System overview DOM tests passed';
} catch (error) {
  document.body.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
}
