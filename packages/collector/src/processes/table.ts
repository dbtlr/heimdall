// One process as the Collector reads it from the process table. This is all it
// reads: the executable's name, never the command line or the environment.
export type ProcessEntry = {
  // CPU time the process has used, user plus system, in microseconds.
  cpuMicros: number;
  // The executable's file name, such as `claude`.
  name: string;
  pid: number;
  ppid: number;
  rssBytes: number;
  // Epoch milliseconds, to the second, the same every time it is read.
  startedAt: number;
};

// Reads the process table of the System it runs on. `table` is one pass over
// every process; `cwdOf` reads one process's working directory, or null when
// it cannot be read.
export type ProcessReader = {
  cwdOf: (pid: number) => Promise<string | null>;
  table: () => Promise<ProcessEntry[]>;
};
