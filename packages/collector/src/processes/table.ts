// One process as the Collector reads it from the process table. This is all it
// reads: the executable's name, never the command line or the environment.
export type ProcessEntry = {
  // User plus system CPU time including reaped children, in microseconds.
  // Subtract `reapedCpuMicros` to measure this process alone.
  cpuMicros: number;
  // The executable's file name, such as `claude`.
  name: string;
  pid: number;
  ppid: number;
  // The part of `cpuMicros` that is children the process has waited for,
  // which an ended process's time moves into. Always 0 where the platform
  // does not count them, as on macOS.
  reapedCpuMicros: number;
  rssBytes: number;
  // The kernel's own record of the start, exact and unmoved by a wall-clock
  // step: clock ticks since boot on Linux, and microseconds since the epoch as
  // the kernel recorded it on macOS. Null when it could not be read. Only
  // compared for equality, within one Collector run.
  kernelStart: number | null;
  // Epoch milliseconds, to the second. On Linux it moves when the wall clock
  // steps, since it is computed from the boot time.
  startedAt: number;
};

// Reads the process table of the System it runs on. `table` is one pass over
// every process; `cwdOf` reads one process's working directory, or null when
// it cannot be read.
export type ProcessReader = {
  cwdOf: (pid: number) => Promise<string | null>;
  table: () => Promise<ProcessEntry[]>;
};

export type ProcessSnapshot = { entries: ProcessEntry[]; presentPids: number[] };

// The full enumeration remains available even when a process's accounting
// fields cannot be read, so an unreadable process is never reported exited.
export type ProcessSamplingReader = ProcessReader & {
  bootId: () => Promise<string>;
  nameOf: (pid: number) => Promise<string | null>;
  snapshot: () => Promise<ProcessSnapshot>;
};
