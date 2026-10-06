import { readFile, statfs } from 'node:fs/promises';
import { cpus, loadavg, totalmem, uptime } from 'node:os';

import type { VitalsSample } from '@heimdall/schema';

import { darwinMounts, diskUsage, linuxMounts } from './disks.ts';
import type { Disk } from './disks.ts';
import { darwinMemory, linuxMemory } from './memory.ts';
import type { HostProbe } from './sampler.ts';

// Runs a system tool by absolute path, since a launchd agent's PATH is minimal.
const runTool = async (cmd: string[]): Promise<string> => {
  const child = Bun.spawn({ cmd, stderr: 'pipe', stdout: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} exited ${String(exitCode)}: ${stderr}`);
  }
  return stdout;
};

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
        disks: async () => usage(darwinMounts(await runTool(['/sbin/mount']))),
        memory: async () => darwinMemory(await runTool(['/usr/bin/vm_stat']), totalmem()),
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
