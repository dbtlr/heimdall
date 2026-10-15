import { expect, test } from 'bun:test';

import { ProcessObservationSchema } from '@heimdall/schema';

import { createProcessObserver } from './observation.ts';
import type { ProcessEntry } from './table.ts';

const entry = (pid: number, cpuMicros: number, over: Partial<ProcessEntry> = {}): ProcessEntry => ({
  cpuMicros,
  kernelStart: pid * 100,
  name: 'bun',
  pid,
  ppid: 1,
  reapedCpuMicros: 0,
  rssBytes: pid * 1000,
  startedAt: 0,
  ...over,
});

test('reports five busiest individual processes and bounds the omitted CPU without counting reaped children', async () => {
  const observer = createProcessObserver();
  const before = Array.from({ length: 7 }, (_, i) => entry(i + 1, 0));
  const first = await observer.observe({
    at: 100_000,
    bootId: 'boot-a',
    entries: before,
    monotonicMs: 1000,
    presentPids: before.map((p) => p.pid),
    uptimeSeconds: 100,
  });
  expect(first).toMatchObject({
    census: { kind: 'complete', unknownPids: [1, 2, 3, 4, 5, 6, 7] },
    intervalMs: 0,
    top: [],
  });
  const after = before.map((p) => entry(p.pid, p.pid * 15_000_000));
  after.push(entry(8, 1_000_000_000, { reapedCpuMicros: 1_000_000_000 }));
  const observed = await observer.observe({
    at: 115_000,
    bootId: 'boot-a',
    entries: after,
    monotonicMs: 16_000,
    presentPids: after.map((p) => p.pid),
    uptimeSeconds: 115,
  });
  expect(observed.intervalMs).toBe(15_000);
  expect(observed.top.map((p) => [p.pid, p.start, p.cpuCores])).toEqual([
    [7, '700', 7],
    [6, '600', 6],
    [5, '500', 5],
    [4, '400', 4],
    [3, '300', 3],
  ]);
  expect(observed.census).toEqual({
    kind: 'complete',
    presentPids: [1, 2, 3, 4, 5, 6, 7, 8],
    remainderMaxCores: 2,
    unknownPids: [8],
  });
});

test('an executable change with the same accounting name cannot label the previous executable CPU', async () => {
  const observer = createProcessObserver();
  let executable = 'old-name';
  const observe = (at: number, cpuMicros: number) =>
    observer.observe({
      at,
      bootId: 'boot-a',
      entries: [entry(1, cpuMicros)],
      monotonicMs: at,
      nameOf: () => Promise.resolve(executable),
      presentPids: [1],
      uptimeSeconds: at / 1000,
    });
  await observe(100_000, 0);
  expect((await observe(115_000, 15_000_000)).top[0]?.name).toBe('old-name');
  executable = 'new-name';
  const changed = await observe(130_000, 30_000_000);
  expect(changed.top).toEqual([]);
  expect(changed.census).toMatchObject({ kind: 'complete', unknownPids: [1] });
  expect((await observe(145_000, 45_000_000)).top[0]?.name).toBe('new-name');
});

test('mutable accounting names and executable permissions retain the lifetime label until a confirmed exec change', async () => {
  const observer = createProcessObserver();
  let fallback = 'worker';
  let executable: string | null = null;
  const observe = (at: number) =>
    observer.observe({
      at,
      bootId: 'boot-a',
      entries: [entry(1, (at - 100_000) * 1000, { name: fallback })],
      monotonicMs: at,
      nameOf: () => Promise.resolve(executable),
      presentPids: [1],
      uptimeSeconds: at / 1000,
    });
  await observe(100_000);
  expect((await observe(115_000)).top[0]?.name).toBe('worker');
  fallback = 'renamed-by-prctl';
  const renamed = await observe(130_000);
  expect(renamed.top[0]).toMatchObject({ cpuCores: 1, name: 'worker' });
  executable = 'actual-worker';
  expect((await observe(145_000)).top[0]?.name).toBe('worker');
  executable = null;
  expect((await observe(160_000)).top[0]?.name).toBe('worker');
  executable = 'actual-worker';
  expect((await observe(175_000)).top[0]?.name).toBe('worker');
  executable = 'replacement';
  const replaced = await observe(190_000);
  expect(replaced.top).toEqual([]);
  expect(replaced.census).toMatchObject({ kind: 'complete', unknownPids: [1] });
  expect((await observe(205_000)).top[0]?.name).toBe('replacement');
});

test.each([
  { at: 145_000, monotonicMs: 115_000, uptimeSeconds: 115 },
  { at: 99_000, monotonicMs: 115_000, uptimeSeconds: 115 },
  { at: 115_000, monotonicMs: 115_000, uptimeSeconds: 1 },
  { at: 115_000, bootId: 'boot-b', monotonicMs: 115_000, uptimeSeconds: 115 },
  { at: 115_000, entries: [entry(1, 0)], monotonicMs: 115_000, uptimeSeconds: 115 },
  {
    at: 115_000,
    entries: [entry(1, 20_000_000, { kernelStart: 101 })],
    monotonicMs: 115_000,
    uptimeSeconds: 115,
  },
])('invalid timing or identity cannot create a busy interval: %j', async (change) => {
  const observer = createProcessObserver();
  await observer.observe({
    at: 100_000,
    bootId: 'boot-a',
    entries: [entry(1, 1_000_000)],
    monotonicMs: 100_000,
    presentPids: [1],
    uptimeSeconds: 100,
  });
  const invalid = await observer.observe({
    bootId: 'boot-a',
    entries: [entry(1, 20_000_000)],
    presentPids: [1],
    ...change,
  });
  expect(invalid.top).toEqual([]);
  expect(invalid.census).toMatchObject({ kind: 'complete', unknownPids: [1] });
});

test('a reaped child never makes its parent busy and census overflow preserves uncertainty', async () => {
  const observer = createProcessObserver();
  await observer.observe({
    at: 100_000,
    bootId: 'boot-a',
    entries: [entry(1, 0)],
    monotonicMs: 100_000,
    presentPids: [1],
    uptimeSeconds: 100,
  });
  const current = await observer.observe({
    at: 115_000,
    bootId: 'boot-a',
    entries: [entry(1, 100_000_000, { reapedCpuMicros: 100_000_000 })],
    monotonicMs: 115_000,
    presentPids: Array.from({ length: 4097 }, (_, i) => i + 1),
    uptimeSeconds: 115,
  });
  expect(current.top[0]?.cpuCores).toBe(0);
  expect(current.census).toEqual({ kind: 'partial' });
});

test('credited time never exceeds the monotonic interval that measured the CPU delta', async () => {
  const observer = createProcessObserver();
  await observer.observe({
    at: 100_000,
    bootId: 'boot-a',
    entries: [entry(1, 0)],
    monotonicMs: 100_000,
    presentPids: [1],
    uptimeSeconds: 100,
  });
  const current = await observer.observe({
    at: 115_000,
    bootId: 'boot-a',
    entries: [entry(1, 5_000_000)],
    monotonicMs: 105_000,
    presentPids: [1],
    uptimeSeconds: 115,
  });
  expect(current.intervalMs).toBe(5000);
  expect(current.top[0]?.cpuCores).toBe(1);
});

test.each([
  { description: 'empty', name: '' },
  { description: 'oversized', name: 'x'.repeat(1025) },
])(
  'an $description process name leaves only its PID unknown and can later recover',
  async ({ name: invalidName }) => {
    const observer = createProcessObserver();
    let name = invalidName;
    const observe = (at: number) =>
      observer.observe({
        at,
        bootId: 'boot-a',
        entries: [entry(1, (at - 100_000) * 2000, { name }), entry(2, (at - 100_000) * 1000)],
        monotonicMs: at,
        nameOf: async () => null,
        presentPids: [1, 2],
        uptimeSeconds: at / 1000,
      });
    await observe(100_000);
    const observed = await observe(115_000);
    expect(ProcessObservationSchema.safeParse(observed).success).toBe(true);
    expect(observed.top.map((process) => process.pid)).toEqual([2]);
    expect(observed.census).toMatchObject({ kind: 'complete', unknownPids: [1] });
    name = 'valid-later';
    expect((await observe(130_000)).top.find((process) => process.pid === 1)?.name).toBe(
      'valid-later',
    );
  },
);

test('an unreadable-but-present process and a discarded CPU baseline do not forget its fallback label', async () => {
  const observer = createProcessObserver();
  let visible = true;
  let name = 'original-label';
  const observe = (at: number) =>
    observer.observe({
      at,
      bootId: 'boot-a',
      entries: visible ? [entry(1, (at - 100_000) * 1000, { name })] : [],
      monotonicMs: at,
      nameOf: async () => null,
      presentPids: [1],
      uptimeSeconds: at / 1000,
    });
  await observe(100_000);
  expect((await observe(115_000)).top[0]?.name).toBe('original-label');
  visible = false;
  await observe(130_000);
  name = 'renamed';
  visible = true;
  expect((await observe(145_000)).top).toEqual([]);
  expect((await observe(160_000)).top[0]?.name).toBe('original-label');
  observer.reset();
  expect((await observe(175_000)).top).toEqual([]);
  expect((await observe(190_000)).top[0]?.name).toBe('original-label');
});

test('exact observation identities preserve all uint64 digits and take precedence over BSD wall-clock starts', async () => {
  const observer = createProcessObserver();
  const observe = (at: number, observationStart: string | null, kernelStart: number) =>
    observer.observe({
      at,
      bootId: 'boot-a',
      entries: [entry(1, (at - 100_000) * 1000, { kernelStart, observationStart })],
      monotonicMs: at,
      presentPids: [1],
      uptimeSeconds: at / 1000,
    });
  await observe(100_000, '18446744073709551614', 100);
  expect((await observe(115_000, '18446744073709551614', 200)).top[0]).toMatchObject({
    cpuCores: 1,
    start: '18446744073709551614',
  });
  expect((await observe(130_000, '18446744073709551615', 200)).top).toEqual([]);
  expect((await observe(145_000, null, 200)).top).toEqual([]);
});
