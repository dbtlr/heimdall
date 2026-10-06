import type { VitalsSample } from '@heimdall/schema';

export type Memory = VitalsSample['memory'];

const KIB = 1024;

// Reads `<label>: <digits>` from a line-per-field report such as /proc/meminfo or vm_stat.
const field = (text: string, label: string): number | undefined => {
  const escaped = label.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
  const match = new RegExp(String.raw`^${escaped}:\s+(\d+)`, 'mu').exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const requiredField = (text: string, label: string, source: string): number => {
  const value = field(text, label);
  if (value === undefined) {
    throw new Error(`${source} has no "${label}" line.`);
  }
  return value;
};

const memory = (totalBytes: number, availableBytes: number): Memory => ({
  totalBytes,
  usedBytes: Math.max(0, totalBytes - availableBytes),
});

// Linux memory from /proc/meminfo: used is what the kernel cannot hand to a new
// process without swapping, total less MemAvailable.
export const linuxMemory = (meminfo: string): Memory =>
  memory(
    requiredField(meminfo, 'MemTotal', '/proc/meminfo') * KIB,
    requiredField(meminfo, 'MemAvailable', '/proc/meminfo') * KIB,
  );

// macOS memory from `vm_stat` output and the physical total. Free, inactive,
// speculative, and purgeable pages are available, matching Linux's MemAvailable.
export const darwinMemory = (vmStat: string, totalBytes: number): Memory => {
  const pageSize = /page size of (\d+) bytes/u.exec(vmStat)?.[1];
  if (pageSize === undefined) {
    throw new Error('vm_stat output has no page size.');
  }
  const pages = ['Pages free', 'Pages inactive', 'Pages speculative', 'Pages purgeable'].reduce(
    (total, label) => total + requiredField(vmStat, label, 'vm_stat output'),
    0,
  );
  return memory(totalBytes, pages * Number(pageSize));
};
