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

// The stored sample nearest `at`, the earlier on a tie, as the Hub reads it.
const nearest = (stored: readonly number[], at: number): number =>
  stored.reduce((best, t) => (Math.abs(t - at) < Math.abs(best - at) ? t : best));

// The overview with the pinned time held as the route holds `at`, from
// `initialAt`, and the sample read for it: the one at `at`, or with `stored`,
// the stored sample nearest it.
function Page({ initialAt, stored }: { initialAt?: number; stored?: readonly number[] }) {
  const [at, setAt] = useState<number | undefined>(initialAt);
  const sampleAt = at === undefined || stored === undefined ? at : nearest(stored, at);
  return (
    <SystemOverview
      at={at}
      attention={[]}
      detail={detail}
      failed={false}
      loading={false}
      onSelect={(t) => {
        pinned.push(t);
        setAt(t);
      }}
      recorded={{ applications: [], files: [], jobs: [], services: [] }}
      sample={sampleAt === undefined ? null : inspected(sampleAt)}
    />
  );
}

// Renders the overview as `page` sets it up, and runs `check` with its slider
// and a way to press a key on it.
async function withSlider(
  page: { initialAt?: number; stored?: readonly number[] },
  check: (slider: HTMLElement, press: (key: string, shiftKey?: boolean) => KeyboardEvent) => void,
) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/'] }),
    routeTree: createRootRoute({ component: () => <Page {...page} /> }),
  });
  await router.load();
  const container = document.createElement('div');
  document.body.append(container);
  const reactRoot = createRoot(container);
  flushSync(() => reactRoot.render(<RouterProvider router={router} />));
  await tick();
  const sliders = container.querySelectorAll<HTMLElement>('[role="slider"]');
  const [slider] = sliders;
  try {
    if (sliders.length !== 1 || slider === undefined) {
      throw new Error('The overview has one time slider');
    }
    check(slider, (key, shiftKey = false) => {
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key,
        shiftKey,
      });
      flushSync(() => slider.dispatchEvent(event));
      return event;
    });
  } finally {
    flushSync(() => reactRoot.unmount());
    container.remove();
  }
}

// Minutes from `start` to `end`, a stored sample each minute.
const minutes = (start: number, end: number) =>
  Array.from({ length: (end - start) / MINUTE + 1 }, (_, index) => start + index * MINUTE);

async function run() {
  await withSlider({}, (slider, press) => {
    const value = (name: string) => slider.getAttribute(name);
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
  });

  // The nearest sample to the window's start lies just before it: Home keeps
  // the slider in the window and still marks the pin at its edge.
  await withSlider(
    { stored: [FROM - 10_000, ...minutes(FROM + 10 * MINUTE, NOW)] },
    (slider, press) => {
      press('Home');
      assert(
        slider.getAttribute('aria-valuenow') === String(FROM),
        `Home stands at the window's start, not ${String(slider.getAttribute('aria-valuenow'))}`,
      );
      assert(
        document.querySelectorAll('div.w-px.bg-select').length > 0,
        "The pin's mark draws at the window's edge",
      );
      assert(
        slider.querySelector('.bg-select') !== null,
        "The pin's time label draws at the window's edge",
      );
    },
  );

  // The last sample before a half-hour gap: each arrow press moves on from the
  // pinned time, not from the sample it snapped back to, so the presses cross.
  const beforeGap = NOW - 3 * 60 * MINUTE;
  await withSlider(
    {
      initialAt: beforeGap,
      stored: [...minutes(FROM, beforeGap), ...minutes(beforeGap + 30 * MINUTE, NOW)],
    },
    (_slider, press) => {
      for (let count = 0; count < 6; count += 1) {
        press('ArrowRight');
      }
      assert(
        pinned.at(-1) === beforeGap + 30 * MINUTE,
        `Six Right presses cross the gap, not stop at ${String(pinned.at(-1))}`,
      );
    },
  );
}

try {
  await run();
  document.body.textContent = 'System overview DOM tests passed';
} catch (error) {
  document.body.textContent =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
}
