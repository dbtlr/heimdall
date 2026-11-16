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

  test('a check that fails outright is like no answer, and checking goes on', async () => {
    const fake = fakeHost();
    const { states } = await watching(fake);
    fake.host.readBuild = () => Promise.reject(new Error('offline'));

    await fake.elapse();
    fake.host.readBuild = () => Promise.resolve(NEWER);
    await fake.elapse();

    expect(fake.state.reloads).toBe(0);
    expect(states.at(-1)).toEqual({ kind: 'ready', ...NEWER });
  });

  test('checks start again on their period once the page is shown again', async () => {
    const fake = fakeHost();
    await watching(fake);
    await fake.show(true);
    await fake.show(false);
    const reads = fake.state.reads;

    await fake.elapse();

    expect(fake.state.scheduled.size).toBe(1);
    expect(fake.state.reads).toBe(reads + 1);
  });

  test('a visibility event while already visible starts no extra check', async () => {
    const fake = fakeHost();
    await watching(fake);

    await fake.show(false);

    expect(fake.state.reads).toBe(1);
    expect(fake.state.scheduled.size).toBe(1);
  });

  test('takes its period from everyMs', () => {
    const fake = fakeHost();
    watchForUpdates(RUNNING, fake.host, () => undefined, { everyMs: 5000 });

    expect(fake.state.periods).toEqual([5000]);
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

// A host whose every read waits for the test to answer it by hand, in order,
// for the interleavings of a check that is out while the page is hidden and
// shown.
const manualHost = () => {
  const state = {
    hidden: false,
    listeners: new Set<() => void>(),
    next: 0,
    pending: [] as ((answer: RunningBuild | undefined) => void)[],
    reloads: 0,
    ticks: new Map<number, () => void>(),
  };
  const host: UpdateHost = {
    isHidden: () => state.hidden,
    onVisibilityChange: (listener) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    readBuild: () => {
      const read = Promise.withResolvers<RunningBuild | undefined>();
      state.pending.push(read.resolve);
      return read.promise;
    },
    reload: () => {
      state.reloads++;
    },
    repeat: (tick) => {
      const id = state.next++;
      state.ticks.set(id, tick);
      return () => state.ticks.delete(id);
    },
  };
  return {
    answer: async (answer: RunningBuild | undefined) => {
      state.pending.shift()?.(answer);
      await settle();
    },
    host,
    show: async (isHidden: boolean) => {
      state.hidden = isHidden;
      for (const listener of state.listeners) {
        listener();
      }
      await settle();
    },
    state,
    tick: async () => {
      for (const tick of state.ticks.values()) {
        tick();
      }
      await settle();
    },
  };
};

describe('watchForUpdates with a check out', () => {
  test('a page shown while a check from before the deploy is out asks again, and reloads on the newer build', async () => {
    const manual = manualHost();
    watchForUpdates(RUNNING, manual.host, () => undefined);
    await manual.answer(RUNNING);
    await manual.tick();

    await manual.show(true);
    await manual.show(false);
    await manual.answer(RUNNING);
    expect(manual.state.pending).toHaveLength(1);
    await manual.answer(NEWER);

    expect(manual.state.reloads).toBe(1);
  });

  test('a page shown while a check is out that then fails, as a suspended fetch does, still reloads', async () => {
    const manual = manualHost();
    watchForUpdates(RUNNING, manual.host, () => undefined);
    await manual.answer(RUNNING);
    await manual.tick();

    await manual.show(true);
    await manual.show(false);
    await manual.answer(undefined);
    await manual.answer(NEWER);

    expect(manual.state.reloads).toBe(1);
  });

  test('a tick while a check is out does not use up a showing', async () => {
    const manual = manualHost();
    watchForUpdates(RUNNING, manual.host, () => undefined);
    await manual.answer(RUNNING);
    await manual.tick();
    await manual.show(true);
    await manual.show(false);

    await manual.tick();
    await manual.answer(RUNNING);
    await manual.answer(NEWER);

    expect(manual.state.reloads).toBe(1);
  });

  test('after a return to the page, a newer build seen later in use is offered, not loaded', async () => {
    const manual = manualHost();
    const states: UpdateState[] = [];
    watchForUpdates(RUNNING, manual.host, (next) => states.push(next));
    await manual.answer(RUNNING);
    await manual.tick();
    await manual.show(true);
    await manual.show(false);
    await manual.answer(RUNNING);
    await manual.answer(RUNNING);

    await manual.tick();
    await manual.answer(NEWER);

    expect(manual.state.reloads).toBe(0);
    expect(states.at(-1)).toEqual({ kind: 'ready', ...NEWER });
  });

  test('after a rollback and a redeploy of the same build, the newer build is offered again', async () => {
    const manual = manualHost();
    const states: UpdateState[] = [];
    watchForUpdates(RUNNING, manual.host, (next) => states.push(next));
    await manual.answer(NEWER);
    await manual.tick();
    await manual.answer(RUNNING);
    await manual.tick();
    await manual.answer(NEWER);

    expect(states.map(({ kind }) => kind)).toEqual(['ready', 'current', 'ready']);
  });
});

const CHUNK_AT = 1_000_000;

// Whether a missing chunk reloads `ms` after the last such reload.
const reloadsAfter = (ms: number) =>
  reloadsForMissingChunk({
    lastReloadAt: CHUNK_AT,
    now: CHUNK_AT + ms,
    running: RUNNING,
    server: NEWER,
  });

describe('reloadsForMissingChunk', () => {
  const at = CHUNK_AT;

  test('reloads when the server runs another build', () => {
    expect(
      reloadsForMissingChunk({ lastReloadAt: undefined, now: at, running: RUNNING, server: NEWER }),
    ).toBe(true);
  });

  test('keeps the error when the server runs this build, or did not answer, as offline', () => {
    expect(
      reloadsForMissingChunk({
        lastReloadAt: undefined,
        now: at,
        running: RUNNING,
        server: RUNNING,
      }),
    ).toBe(false);
    expect(
      reloadsForMissingChunk({
        lastReloadAt: undefined,
        now: at,
        running: RUNNING,
        server: undefined,
      }),
    ).toBe(false);
  });

  test('does not reload again within a minute of the last such reload, so it cannot loop', () => {
    expect(CHUNK_RELOAD_GAP_MS).toBe(60_000);
    expect(reloadsAfter(59_999)).toBe(false);
    expect(reloadsAfter(60_000)).toBe(true);
  });
});
