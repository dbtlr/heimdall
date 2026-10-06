import type { CpuInfo } from 'node:os';

export type CpuTimes = CpuInfo['times'];

const busyTicks = (times: CpuTimes) => times.user + times.nice + times.sys + times.irq;

const sum = (cores: readonly CpuTimes[], ticks: (times: CpuTimes) => number) =>
  cores.reduce((total, times) => total + ticks(times), 0);

// The share of the interval all cores together spent busy, from two readings of
// `os.cpus()` times.
export const cpuBusyPercent = (before: readonly CpuTimes[], after: readonly CpuTimes[]): number => {
  const busy = sum(after, busyTicks) - sum(before, busyTicks);
  const idle = sum(after, (times) => times.idle) - sum(before, (times) => times.idle);
  const total = busy + idle;
  return total > 0 ? Math.max(0, (busy / total) * 100) : 0;
};
