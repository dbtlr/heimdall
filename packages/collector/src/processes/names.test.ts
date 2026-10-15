import { expect, test } from 'bun:test';

import { tempStateDir } from '../testing/fixtures.ts';
import { openProcessNames } from './names.ts';
import { createProcessObserver } from './observation.ts';
import type { ProcessEntry } from './table.ts';

const start = '18446744073709551615';
const entry = (at: number, name: string): ProcessEntry => ({
  cpuMicros: (at - 100_000) * 1000,
  kernelStart: null,
  name,
  observationStart: start,
  pid: 42,
  ppid: 1,
  reapedCpuMicros: 0,
  rssBytes: 1000,
  startedAt: 0,
});

const observeFallback = (
  at: number,
  target: ReturnType<typeof createProcessObserver>,
  name: string,
) =>
  target.observe({
    at,
    bootId: 'boot-a',
    entries: [entry(at, name)],
    monotonicMs: at,
    nameOf: async () => null,
    presentPids: [42],
    uptimeSeconds: at / 1000,
  });

test('a Collector restart retains the published fallback label and resets only the CPU baseline', async () => {
  await using dir = await tempStateDir();
  const before = await openProcessNames({ stateDir: dir.path });
  const observer = createProcessObserver({ names: before });
  await observeFallback(100_000, observer, 'node');
  expect((await observeFallback(115_000, observer, 'node')).top[0]?.name).toBe('node');
  before.close();

  const reopened = await openProcessNames({ stateDir: dir.path });
  try {
    const restarted = createProcessObserver({ names: reopened });
    const first = await observeFallback(130_000, restarted, 'renamed-by-prctl');
    expect(first.intervalMs).toBe(0);
    expect(first.top).toEqual([]);
    expect((await observeFallback(145_000, restarted, 'renamed-by-prctl')).top[0]).toMatchObject({
      cpuCores: 1,
      name: 'node',
      start,
    });
  } finally {
    reopened.close();
  }
});

test('confirmed executable evidence survives restart and still distinguishes a real executable replacement', async () => {
  await using dir = await tempStateDir();
  const firstStore = await openProcessNames({ stateDir: dir.path });
  const first = createProcessObserver({ names: firstStore });
  let executable: string | null = 'node';
  const observe = (at: number, target: ReturnType<typeof createProcessObserver>) =>
    target.observe({
      at,
      bootId: 'boot-a',
      entries: [entry(at, 'mutable-accounting-name')],
      monotonicMs: at,
      nameOf: async () => executable,
      presentPids: [42],
      uptimeSeconds: at / 1000,
    });
  await observe(100_000, first);
  expect((await observe(115_000, first)).top[0]?.name).toBe('node');
  firstStore.close();

  const secondStore = await openProcessNames({ stateDir: dir.path });
  const second = createProcessObserver({ names: secondStore });
  executable = null;
  await observe(130_000, second);
  expect((await observe(145_000, second)).top[0]?.name).toBe('node');
  executable = 'replacement';
  const changed = await observe(160_000, second);
  expect(changed.top).toEqual([]);
  expect(changed.census).toMatchObject({ kind: 'complete', unknownPids: [42] });
  expect((await observe(175_000, second)).top[0]?.name).toBe('replacement');
  secondStore.close();

  const thirdStore = await openProcessNames({ stateDir: dir.path });
  try {
    const third = createProcessObserver({ names: thirdStore });
    executable = null;
    await observe(190_000, third);
    expect((await observe(205_000, third)).top[0]?.name).toBe('replacement');
  } finally {
    thirdStore.close();
  }
});

test('durable name pruning retains unreadable present lifetimes and forgets only confirmed exit, replacement or boot change', async () => {
  await using dir = await tempStateDir();
  const names = await openProcessNames({ stateDir: dir.path });
  try {
    names.save({ bootId: 'boot-a', kind: 'fallback', label: 'present', pid: 42, start });
    names.save({ bootId: 'boot-a', kind: 'fallback', label: 'exited', pid: 43, start: '11' });
    const observer = createProcessObserver({ names });
    const observe = (at: number, entries: ProcessEntry[], bootId = 'boot-a') =>
      observer.observe({
        at,
        bootId,
        entries,
        monotonicMs: at,
        presentPids: [42],
        uptimeSeconds: at / 1000,
      });
    await observe(100_000, []);
    expect(names.list()).toEqual([
      { bootId: 'boot-a', kind: 'fallback', label: 'present', pid: 42, start },
    ]);
    await observe(115_000, [
      { ...entry(115_000, 'new-lifetime'), observationStart: '18446744073709551614' },
    ]);
    expect(names.list()).toEqual([]);
    names.save({ bootId: 'boot-a', kind: 'fallback', label: 'old-boot', pid: 42, start });
    const afterRestart = createProcessObserver({ names });
    await afterRestart.observe({
      at: 130_000,
      bootId: 'boot-b',
      entries: [],
      monotonicMs: 130_000,
      presentPids: [42],
      uptimeSeconds: 10,
    });
    expect(names.list()).toEqual([]);
  } finally {
    names.close();
  }
});
