import { describe, expect, test } from 'bun:test';

import {
  CHUNK_RELOAD_GAP_MS,
  reloadsForMissingChunk,
  UPDATE_CHECK_EVERY_MS,
  watchForUpdates,
} from './update-watch.ts';
import type { RunningBuild, UpdateHost, UpdateState } from './update-watch.ts';

const RUNNING: RunningBuild = { build: '1.0.0+a', version: '1.0.0' };
const NEWER = { build: '1.1.0+b', version: '1.1.0' };

// A host whose clock, visibility, and server answer a test moves by hand. Each
// read of the server's build waits until the test settles it, so a test can
// see what happens while a read is still out.
const fakeHost = (hidden = false) => {
  const state = {
    answer: RUNNING as RunningBuild | undefined,
    hidden,
    listeners: new Set<() => void>(),
    next: 0,
    periods: [] as number[],
    reads: 0,
    reloads: 0,
    scheduled: new Map<number, () => void>(),
  };
  const host: UpdateHost = {
    isHidden: () => state.hidden,
    onVisibilityChange: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    readBuild: () => {
      state.reads++;
      return Promise.resolve(state.answer);
    },
    reload: () => {
      state.reloads++;
    },
    repeat: (tick, everyMs) => {
      const id = state.next++;
      state.scheduled.set(id, tick);
      state.periods.push(everyMs);
      return () => state.scheduled.delete(id);
    },
  };
  return {
    // Runs every timer once, as a period passing would, then lets the reads it
    // started answer.
    elapse: async () => {
      for (const tick of state.scheduled.values()) {
        tick();
      }
      await settle();
    },
    host,
    serve: (answer: RunningBuild | undefined) => {
      state.answer = answer;
    },
    show: async (isHidden: boolean) => {
      state.hidden = isHidden;
      for (const listener of state.listeners) {
        listener();
      }
      await settle();
    },
    state,
  };
};

// Lets every resolved promise's callbacks run: a timer turn comes after them all.
const settle = () => Bun.sleep(0);

const watching = async (fake: ReturnType<typeof fakeHost>) => {
  const states: UpdateState[] = [];
  const stop = watchForUpdates(RUNNING, fake.host, (next) => states.push(next));
  await settle();
  return { states, stop };
};

describe('watchForUpdates', () => {
  test('checks the server once at start and then about once a minute while visible', async () => {
    const fake = fakeHost();
    const { states } = await watching(fake);

    expect(UPDATE_CHECK_EVERY_MS).toBe(60_000);
    expect(fake.state.periods).toEqual([60_000]);
    expect(fake.state.reads).toBe(1);
    expect(states).toEqual([{ kind: 'current' }]);

    await fake.elapse();
    expect(fake.state.reads).toBe(2);
  });

  test('a running build the server still serves changes nothing and never reloads', async () => {
    const fake = fakeHost();
    const { states } = await watching(fake);

    await fake.elapse();
    await fake.show(true);
    await fake.show(false);

    expect(fake.state.reloads).toBe(0);
    expect(states.every(({ kind }) => kind === 'current')).toBe(true);
  });

  test('a newer build seen while the page is in use is offered, not loaded', async () => {
    const fake = fakeHost();
    const { states } = await watching(fake);

    fake.serve(NEWER);
    await fake.elapse();

    expect(fake.state.reloads).toBe(0);
    expect(states.at(-1)).toEqual({ kind: 'ready', ...NEWER });
  });

  test('the offer is made once per newer build, not on every check', async () => {
    const fake = fakeHost();
    const { states } = await watching(fake);

    fake.serve(NEWER);
    await fake.elapse();
    await fake.elapse();

    expect(states.filter(({ kind }) => kind === 'ready')).toHaveLength(1);
  });

  test('coming back from the background to a newer build reloads at once', async () => {
    const fake = fakeHost();
    await watching(fake);

    await fake.show(true);
    fake.serve(NEWER);
    await fake.show(false);

    expect(fake.state.reloads).toBe(1);
  });

  test('coming back with the offer already showing reloads too', async () => {
    const fake = fakeHost();
    await watching(fake);
    fake.serve(NEWER);
    await fake.elapse();

    await fake.show(true);
    await fake.show(false);

    expect(fake.state.reloads).toBe(1);
  });

  test('opening the app in the background on a newer build reloads once it is shown', async () => {
    const fake = fakeHost(true);
    fake.serve(NEWER);
    await watching(fake);
    expect(fake.state.reloads).toBe(0);

    await fake.show(false);

    expect(fake.state.reloads).toBe(1);
  });

  test('checks pause while the page is hidden', async () => {
    const fake = fakeHost();
    await watching(fake);

    await fake.show(true);
    await fake.elapse();

    expect(fake.state.scheduled.size).toBe(0);
    expect(fake.state.reads).toBe(1);
  });

  test('a server that does not answer leaves the state alone and never reloads', async () => {
    const fake = fakeHost();
    const { states } = await watching(fake);

    fake.serve(undefined);
    await fake.elapse();
    await fake.show(true);
    await fake.show(false);

    expect(fake.state.reloads).toBe(0);
    expect(states).toEqual([{ kind: 'current' }]);
  });

  test('a check that is still out is not started again', async () => {
    const fake = fakeHost();
    let answer = Promise.withResolvers<RunningBuild>();
    fake.host.readBuild = () => {
      fake.state.reads++;
      answer = Promise.withResolvers<RunningBuild>();
      return answer.promise;
    };
    watchForUpdates(RUNNING, fake.host, () => undefined);

    await fake.elapse();
    await fake.elapse();
    expect(fake.state.reads).toBe(1);

    answer.resolve(RUNNING);
    await settle();
    await fake.elapse();
    expect(fake.state.reads).toBe(2);
  });

  test('a page shown while a check is out reloads when that check finds a newer build', async () => {
    const fake = fakeHost();
    const answer = Promise.withResolvers<RunningBuild>();
    fake.host.readBuild = () => answer.promise;
    watchForUpdates(RUNNING, fake.host, () => undefined);

    await fake.show(true);
    await fake.show(false);
    answer.resolve(NEWER);
    await settle();

    expect(fake.state.reloads).toBe(1);
  });

  test('stopping cancels the timer and the listener, and ignores an answer still out', async () => {
    const fake = fakeHost();
    const states: UpdateState[] = [];
    fake.serve(NEWER);
    const stop = watchForUpdates(RUNNING, fake.host, (next) => states.push(next));

    stop();
    await settle();

    expect(fake.state.scheduled.size).toBe(0);
    expect(fake.state.listeners.size).toBe(0);
    expect(states).toEqual([]);
  });
});

describe('reloadsForMissingChunk', () => {
  test('reloads for the first missing chunk', () => {
    expect(reloadsForMissingChunk(undefined, 1_000_000)).toBe(true);
  });

  test('does not reload again soon after the last such reload, so a chunk that stays missing cannot loop', () => {
    expect(CHUNK_RELOAD_GAP_MS).toBe(60_000);
    expect(reloadsForMissingChunk(1_000_000, 1_000_000 + 59_999)).toBe(false);
    expect(reloadsForMissingChunk(1_000_000, 1_000_000 + 60_000)).toBe(true);
  });
});
