import type { VitalsSample } from '@heimdall/schema';

export type Memory = VitalsSample['memory'];

// XNU exposes dispatch pressure flags, rather than its internal pressure enum.
export const darwinMemoryPressure = (text: string): Memory['pressure'] => {
  switch (text.trim()) {
    case '1': {
      return 'normal';
    }
    case '2': {
      return 'warning';
    }
    case '4': {
      return 'critical';
    }
    default: {
      return undefined;
    }
  }
};

// A missing pressure probe leaves the rest of a Vitals sample usable.
export const readDarwinMemory = async ({
  read,
  totalBytes,
}: {
  read: (command: string[]) => Promise<string>;
  totalBytes: number;
}): Promise<Memory> => {
  const [vmStat, pressure] = await Promise.all([
    read(['/usr/bin/vm_stat']),
    read(['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level']).then(
      darwinMemoryPressure,
      () => undefined,
    ),
  ]);
  return { ...darwinMemory(vmStat, totalBytes), ...(pressure === undefined ? {} : { pressure }) };
};

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
