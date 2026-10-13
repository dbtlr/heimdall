import { describe, expect, test } from 'bun:test';

import { keepRefreshing, REFRESH_EVERY_MS } from './refresh.ts';
import type { RefreshHost } from './refresh.ts';

// A host whose clock and visibility a test moves by hand.
const fakeHost = (hidden = false) => {
  const state = {
    hidden,
    listeners: new Set<() => void>(),
    next: 0,
    scheduled: new Map<number, { everyMs: number; tick: () => void }>(),
  };
  const host: RefreshHost = {
    isHidden: () => state.hidden,
    onVisibilityChange: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    repeat: (tick, everyMs) => {
      const id = state.next++;
      state.scheduled.set(id, { everyMs, tick });
      return () => state.scheduled.delete(id);
    },
  };
  return {
    // Runs every timer once, as a period passing would.
    elapse: () => {
      for (const { tick } of state.scheduled.values()) {
        tick();
      }
    },
    host,
    listening: () => state.listeners.size,
    periods: () => [...state.scheduled.values()].map(({ everyMs }) => everyMs),
    running: () => state.scheduled.size,
    show: (isHidden: boolean) => {
      state.hidden = isHidden;
      for (const listener of state.listeners) {
        listener();
      }
    },
  };
};

describe('keepRefreshing', () => {
  test('refreshes every 15 seconds while the document is visible', () => {
    const fake = fakeHost();
    let refreshes = 0;

    keepRefreshing(() => refreshes++, fake.host);
    expect(fake.periods()).toEqual([15_000]);
    expect(REFRESH_EVERY_MS).toBe(15_000);
    expect(refreshes).toBe(0);

    fake.elapse();
    fake.elapse();
    expect(refreshes).toBe(2);
  });

  test('pauses while the document is hidden', () => {
    const fake = fakeHost();
    let refreshes = 0;
    keepRefreshing(() => refreshes++, fake.host);

    fake.show(true);
    expect(fake.running()).toBe(0);
    fake.elapse();

    expect(refreshes).toBe(0);
  });

  test('refreshes at once when the document becomes visible again, then keeps its period', () => {
    const fake = fakeHost();
    let refreshes = 0;
    keepRefreshing(() => refreshes++, fake.host);
    fake.show(true);

    fake.show(false);
    expect(refreshes).toBe(1);
    expect(fake.running()).toBe(1);

    fake.elapse();
    expect(refreshes).toBe(2);
  });

  test('does not start a second timer or an extra refresh when a visible document reports visible again', () => {
    const fake = fakeHost();
    let refreshes = 0;
    keepRefreshing(() => refreshes++, fake.host);

    fake.show(false);

    expect(fake.running()).toBe(1);
    expect(refreshes).toBe(0);
  });

  test('starts paused for a document that opens hidden, and refreshes when it shows', () => {
    const fake = fakeHost(true);
    let refreshes = 0;
    keepRefreshing(() => refreshes++, fake.host);
    expect(fake.running()).toBe(0);

    fake.show(false);

    expect(refreshes).toBe(1);
    expect(fake.running()).toBe(1);
  });

  test('stops its timer and its listener', () => {
    const fake = fakeHost();
    const stop = keepRefreshing(() => undefined, fake.host);

    stop();

    expect(fake.running()).toBe(0);
    expect(fake.listening()).toBe(0);
  });
});
