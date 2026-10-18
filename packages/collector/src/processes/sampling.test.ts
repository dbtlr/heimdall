import { expect, test } from 'bun:test';

import { sample } from '@heimdall/schema/testing';

import { createProcessSampling } from './sampling.ts';
import type { ProcessEntry, ProcessSamplingReader } from './table.ts';

test('one table read feeds queued process evidence and Harness readings, while read failures cost only process evidence', async () => {
  let reads = 0;
  let failing = false;
  let now = 100_000;
  let cpuMicros = 0;
  const entry = (): ProcessEntry => ({
    cpuMicros,
    kernelStart: 1,
    name: 'claude',
    pid: 2,
    ppid: 1,
    reapedCpuMicros: 0,
    rssBytes: 1000,
    startedAt: 0,
  });
  const reader: ProcessSamplingReader = {
    bootId: () => Promise.resolve('boot-a'),
    cwdOf: () => Promise.resolve('/work'),
    nameOf: () => Promise.resolve('claude'),
    snapshot: () => {
      reads += 1;
      return failing
        ? Promise.reject(new Error('cannot read'))
        : Promise.resolve({ entries: [entry()], presentPids: [2] });
    },
    table: () => {
      throw new Error('must reuse snapshot');
    },
  };
  const warnings: string[] = [];
  const sampling = createProcessSampling({
    log: { info: () => {}, warn: (message) => warnings.push(message) },
    monotonicMs: () => now,
    now: () => now,
    reader,
    sampler: { sample: () => Promise.resolve({ ...sample(now), uptimeSeconds: now / 1000 }) },
    uptimeSeconds: () => now / 1000,
  });
  await sampling.sample();
  now += 15_000;
  cpuMicros += 15_000_000;
  const busy = await sampling.sample();
  expect(reads).toBe(2);
  expect(busy.processes?.top[0]?.cpuCores).toBe(1);
  expect(sampling.latest()?.processes[0]).toMatchObject({
    cpuMicros: 15_000_000,
    cwd: '/work',
    lastSeenAt: now,
  });
  failing = true;
  now += 15_000;
  const unreadable = await sampling.sample();
  expect(unreadable.processes).toBeUndefined();
  expect(sampling.latest()?.processes[0]?.lastSeenAt).toBe(115_000);
  failing = false;
  now += 15_000;
  expect((await sampling.sample()).processes?.intervalMs).toBe(0);
  expect(warnings).toHaveLength(1);
});

test('CPU uses the elapsed observation time when a table read takes longer than its predecessor', async () => {
  let now = 100_000;
  let reads = 0;
  const snapshot = async () => {
    reads += 1;
    if (reads === 2) {
      now += 5000;
    }
    return {
      entries: [
        {
          cpuMicros: reads === 1 ? 0 : 20_000_000,
          kernelStart: 1,
          name: 'bun',
          pid: 2,
          ppid: 1,
          reapedCpuMicros: 0,
          rssBytes: 0,
          startedAt: 0,
        },
      ],
      presentPids: [2],
    };
  };
  const sampling = createProcessSampling({
    log: { info: () => {}, warn: () => {} },
    monotonicMs: () => now,
    now: () => now,
    reader: {
      bootId: async () => 'boot-a',
      cwdOf: async () => null,
      nameOf: async () => 'bun',
      snapshot,
      table: async () => [],
    },
    sampler: { sample: async () => sample(now) },
    uptimeSeconds: () => now / 1000,
  });
  await sampling.sample();
  now = 115_000;
  const observed = await sampling.sample();
  expect(observed.processes?.top[0]?.cpuCores).toBe(1);
  expect(observed.t).toBe(120_000);
});

test('a host-probe rejection still updates Harness readings and invalidates the hot CPU baseline', async () => {
  let now = 100_000;
  let failing = false;
  let reads = 0;
  const sampling = createProcessSampling({
    log: { info: () => {}, warn: () => {} },
    monotonicMs: () => now,
    now: () => now,
    reader: {
      bootId: async () => 'boot-a',
      cwdOf: async () => '/work',
      nameOf: async () => 'claude',
      snapshot: async () => {
        reads += 1;
        return {
          entries: [
            {
              cpuMicros: (now - 100_000) * 1000,
              kernelStart: 1,
              name: 'claude',
              pid: 2,
              ppid: 1,
              reapedCpuMicros: 0,
              rssBytes: 0,
              startedAt: 0,
            },
          ],
          presentPids: [2],
        };
      },
      table: async () => {
        throw new Error('must reuse snapshot');
      },
    },
    sampler: {
      sample: async () => {
        if (failing) {
          throw new Error('disk probe failed');
        }
        return sample(now);
      },
    },
    uptimeSeconds: () => now / 1000,
  });
  await sampling.sample();
  now = 115_000;
  failing = true;
  expect(sampling.sample()).rejects.toThrow('disk probe failed');
  expect(sampling.latest()?.processes[0]).toMatchObject({
    cpuMicros: 15_000_000,
    lastSeenAt: 115_000,
  });
  failing = false;
  now = 130_000;
  expect((await sampling.sample()).processes?.intervalMs).toBe(0);
  now = 145_000;
  expect((await sampling.sample()).processes?.top[0]?.cpuCores).toBe(1);
  expect(reads).toBe(4);
});

test('a host probe that has not settled does not hold back a successful Harness snapshot', async () => {
  const host = Promise.withResolvers<ReturnType<typeof sample>>();
  const sampling = createProcessSampling({
    log: { info: () => {}, warn: () => {} },
    monotonicMs: () => 100_000,
    now: () => 100_000,
    reader: {
      bootId: async () => 'boot-a',
      cwdOf: async () => '/work',
      nameOf: async () => 'claude',
      snapshot: async () => ({
        entries: [
          {
            cpuMicros: 42,
            kernelStart: 1,
            name: 'claude',
            pid: 2,
            ppid: 1,
            reapedCpuMicros: 0,
            rssBytes: 0,
            startedAt: 0,
          },
        ],
        presentPids: [2],
      }),
      table: async () => {
        throw new Error('must reuse snapshot');
      },
    },
    repositoryOf: async () => null,
    sampler: { sample: () => host.promise },
    uptimeSeconds: () => 100,
  });
  const pending = sampling.sample();
  try {
    await Bun.sleep(0);
    expect(sampling.latest()?.processes[0]).toMatchObject({ cpuMicros: 42, lastSeenAt: 100_000 });
  } finally {
    host.resolve(sample(100_000));
    await pending;
  }
});

test('a hung host read times out once, allowing later process scans without starting more host reads', async () => {
  const host = Promise.withResolvers<ReturnType<typeof sample>>();
  let now = 100_000;
  let hostReads = 0;
  let tableReads = 0;
  const sampling = createProcessSampling({
    hostTimeoutMs: 5,
    log: { info: () => {}, warn: () => {} },
    monotonicMs: () => now,
    now: () => now,
    reader: {
      bootId: async () => 'boot-a',
      cwdOf: async () => '/work',
      nameOf: async () => 'claude',
      snapshot: async () => {
        tableReads += 1;
        return {
          entries: [
            {
              cpuMicros: now * 1000,
              kernelStart: 1,
              name: 'claude',
              pid: 2,
              ppid: 1,
              reapedCpuMicros: 0,
              rssBytes: 0,
              startedAt: 0,
            },
          ],
          presentPids: [2],
        };
      },
      table: async () => {
        throw new Error('must reuse snapshot');
      },
    },
    sampler: {
      sample: () => {
        hostReads += 1;
        return hostReads === 1 ? host.promise : Promise.resolve(sample(now));
      },
    },
    uptimeSeconds: () => now / 1000,
  });
  try {
    const outcome = await Promise.race([
      sampling.sample().then(
        () => 'unexpected sample',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      Bun.sleep(100).then(() => 'did not time out'),
    ]);
    expect(outcome).toContain('Host Vitals read exceeded');
    now += 15_000;
    expect(sampling.sample()).rejects.toThrow('still pending');
    expect(tableReads).toBe(2);
    expect(hostReads).toBe(1);
    expect(sampling.latest()?.processes[0]?.lastSeenAt).toBe(115_000);
  } finally {
    host.resolve(sample(100_000));
    await Bun.sleep(0);
  }
  now += 15_000;
  const recovered = await sampling.sample();
  expect(recovered.t).toBe(130_000);
  expect(recovered.processes?.intervalMs).toBe(0);
  expect(hostReads).toBe(2);
});
