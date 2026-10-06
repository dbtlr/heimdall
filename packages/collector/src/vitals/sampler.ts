import type { VitalsSample } from '@heimdall/schema';

import { cpuBusyPercent } from './cpu.ts';
import type { CpuTimes } from './cpu.ts';
import type { Disk } from './disks.ts';
import type { Memory } from './memory.ts';

// The readings one platform offers. `host.ts` supplies the real ones per
// operating system; tests supply their own.
export type HostProbe = {
  cpuTimes: () => CpuTimes[];
  disks: () => Promise<Disk[]>;
  load: () => VitalsSample['load'];
  memory: () => Promise<Memory>;
  // Interval clock that never jumps, for averaging CPU.
  monotonicMs: () => number;
  // Wall clock, for the sample's `t`.
  nowMs: () => number;
  // User plus system CPU time the Collector process has used.
  processCpuMicros: () => number;
  processRssBytes: () => number;
  uptimeSeconds: () => number;
};

export type Sampler = { sample: () => Promise<VitalsSample> };

// Takes Vitals samples from a host. CPU figures average the interval since the
// previous sample, or since creation for the first one.
export const createSampler = (probe: HostProbe): Sampler => {
  let previous = {
    cpuTimes: probe.cpuTimes(),
    monotonicMs: probe.monotonicMs(),
    processCpuMicros: probe.processCpuMicros(),
  };

  return {
    async sample() {
      // The interval readings come first and together; the slower reads follow.
      const current = {
        cpuTimes: probe.cpuTimes(),
        monotonicMs: probe.monotonicMs(),
        processCpuMicros: probe.processCpuMicros(),
      };
      const elapsedMicros = (current.monotonicMs - previous.monotonicMs) * 1000;
      const capacityMicros = elapsedMicros * Math.max(1, current.cpuTimes.length);
      const processMicros = current.processCpuMicros - previous.processCpuMicros;
      const [disks, memory] = await Promise.all([probe.disks(), probe.memory()]);
      if (disks.length === 0) {
        throw new Error('found no disk to report.');
      }
      const sample: VitalsSample = {
        collector: {
          cpuPercent: capacityMicros > 0 ? Math.max(0, (processMicros / capacityMicros) * 100) : 0,
          rssBytes: probe.processRssBytes(),
        },
        cpu: { busyPercent: cpuBusyPercent(previous.cpuTimes, current.cpuTimes) },
        disks,
        load: probe.load(),
        memory,
        t: Math.trunc(probe.nowMs()),
        uptimeSeconds: probe.uptimeSeconds(),
      };
      previous = current;
      return sample;
    },
  };
};
