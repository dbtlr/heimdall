import { readFile, statfs } from 'node:fs/promises';
import { cpus, loadavg, totalmem, uptime } from 'node:os';

import type { VitalsSample } from '@heimdall/schema';

import { readCommand } from '../subprocess.ts';
import { darwinMounts, diskUsage, linuxMounts } from './disks.ts';
import type { Disk } from './disks.ts';
import { darwinMemory, linuxMemory } from './memory.ts';
import type { HostProbe } from './sampler.ts';

// Usage for each mount point. A mount that vanished since it was listed is skipped.
const usage = async (mountPoints: string[]): Promise<Disk[]> => {
  const disks = await Promise.all(
    mountPoints.map(async (mount) => {
      try {
        return [diskUsage(mount, await statfs(mount))];
      } catch {
        return [];
      }
    }),
  );
  return disks.flat();
};

const platformReadings = (platform: NodeJS.Platform): Pick<HostProbe, 'disks' | 'memory'> => {
  switch (platform) {
    case 'darwin': {
      return {
        disks: async () => usage(darwinMounts(await readCommand(['/sbin/mount']))),
        memory: async () => darwinMemory(await readCommand(['/usr/bin/vm_stat']), totalmem()),
      };
    }
    case 'linux': {
      return {
        disks: async () => usage(linuxMounts(await readFile('/proc/self/mounts', 'utf8'))),
        memory: async () => linuxMemory(await readFile('/proc/meminfo', 'utf8')),
      };
    }
    default: {
      throw new Error(`The Collector samples macOS and Linux, not ${platform}.`);
    }
  }
};

// The readings of the System this process runs on.
export const hostProbe = (platform: NodeJS.Platform = process.platform): HostProbe => ({
  ...platformReadings(platform),
  cpuTimes: () => cpus().map((cpu) => cpu.times),
  load: (): VitalsSample['load'] => {
    const [one = 0, five = 0, fifteen = 0] = loadavg();
    return [one, five, fifteen];
  },
  monotonicMs: () => performance.now(),
  nowMs: () => Date.now(),
  processCpuMicros: () => {
    const { system, user } = process.cpuUsage();
    return user + system;
  },
  processRssBytes: () => process.memoryUsage.rss(),
  uptimeSeconds: () => uptime(),
});
