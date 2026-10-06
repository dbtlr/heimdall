import { expect, test } from 'bun:test';

import { VitalsSampleSchema } from '@heimdall/schema';

import { createSampler } from './sampler.ts';
import type { HostProbe } from './sampler.ts';

// A host with two cores whose readings advance by hand.
const fakeHost = () => {
  const state = {
    busyTicks: 0,
    idleTicks: 0,
    monotonicMs: 1000,
    processCpuMicros: 0,
    wallMs: 1_759_700_000_000,
  };
  const core = () => ({ idle: state.idleTicks, irq: 0, nice: 0, sys: 0, user: state.busyTicks });
  const probe: HostProbe = {
    cpuTimes: () => [core(), core()],
    disks: () => Promise.resolve([{ mount: '/', totalBytes: 1000, usedBytes: 400 }]),
    load: () => [1.5, 1, 0.5],
    memory: () => Promise.resolve({ totalBytes: 2048, usedBytes: 1024 }),
    monotonicMs: () => state.monotonicMs,
    nowMs: () => state.wallMs,
    processCpuMicros: () => state.processCpuMicros,
    processRssBytes: () => 41_943_040,
    uptimeSeconds: () => 86_400.5,
  };
  // Lets 15 seconds pass with each core busy for `busyShare` of it.
  const advance = (busyShare: number, processCpuMicros: number) => {
    state.busyTicks += 1500 * busyShare;
    state.idleTicks += 1500 * (1 - busyShare);
    state.monotonicMs += 15_000;
    state.wallMs += 15_000;
    state.processCpuMicros += processCpuMicros;
  };
  return { advance, probe };
};

test('a host with no disk to report fails the sample instead of sending an invalid one', async () => {
  const host = fakeHost();
  const sampler = createSampler({ ...host.probe, disks: () => Promise.resolve([]) });

  const failure = await sampler.sample().catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain('no disk');
});

test('a sample averages CPU over the interval since the previous one', async () => {
  const host = fakeHost();
  const sampler = createSampler(host.probe);

  host.advance(0.25, 0);
  expect((await sampler.sample()).cpu.busyPercent).toBe(25);

  host.advance(0.75, 0);
  expect((await sampler.sample()).cpu.busyPercent).toBe(75);
});

test("the Collector's CPU share spans every core", async () => {
  const host = fakeHost();
  const sampler = createSampler(host.probe);

  // 0.3 CPU-seconds over 15 seconds on 2 cores is 1 percent.
  host.advance(0, 300_000);

  expect((await sampler.sample()).collector).toEqual({ cpuPercent: 1, rssBytes: 41_943_040 });
});

test('a sample carries the host readings at wall-clock time and passes the Report schema', async () => {
  const host = fakeHost();
  const sampler = createSampler(host.probe);
  host.advance(0.5, 0);

  const sample = await sampler.sample();

  expect(sample).toEqual({
    collector: { cpuPercent: 0, rssBytes: 41_943_040 },
    cpu: { busyPercent: 50 },
    disks: [{ mount: '/', totalBytes: 1000, usedBytes: 400 }],
    load: [1.5, 1, 0.5],
    memory: { totalBytes: 2048, usedBytes: 1024 },
    t: 1_759_700_015_000,
    uptimeSeconds: 86_400.5,
  });
  expect(VitalsSampleSchema.safeParse(sample).success).toBe(true);
});
