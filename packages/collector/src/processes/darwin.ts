import { HARNESS_NAMES, HARNESSES } from '../harnesses.ts';
import { runCommand } from '../subprocess.ts';
import { darwinCwd, darwinKernelStart } from './darwin-libproc.ts';
import type { ProcessEntry, ProcessReader } from './table.ts';

// The columns the Collector asks `ps` for on macOS. `comm` is the executable's
// path. No column carries a process's arguments or environment.
export const PS_COLUMNS = 'pid=,ppid=,rss=,etime=,time=,comm=';

const MICROS_PER_SECOND = 1_000_000;
const MICROS_PER_MS = 1000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_UNIT = [1, 60, 3600];
const SECONDS_PER_DAY = 86_400;

// A `ps` duration, `[[dd-]hh:]mm:ss[.ff]`, in seconds.
const seconds = (text: string) => {
  const [days, clock] = text.includes('-') ? text.split('-') : [undefined, text];
  const parts = (clock ?? '').split(':').map(Number).toReversed();
  if (parts.length > SECONDS_PER_UNIT.length || parts.some((n) => !Number.isFinite(n))) {
    return undefined;
  }
  const total = parts.reduce((sum, n, i) => sum + n * (SECONDS_PER_UNIT[i] ?? 0), 0);
  return total + (days === undefined ? 0 : Number(days) * SECONDS_PER_DAY);
};

const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/u;

// Epoch milliseconds to the second, as every start is reported.
const toSecond = (ms: number) => Math.floor(ms / MS_PER_SECOND) * MS_PER_SECOND;

const HARNESS_PROCESS_NAMES = new Set(HARNESS_NAMES.flatMap((h) => HARNESSES[h].process.names));

// The processes in `ps` output taken at `nowMs`. A line that is not a process
// is skipped. A start is the time `etime` ago, to the second, with no kernel
// start.
export const parsePs = (output: string, nowMs: number): ProcessEntry[] =>
  output.split('\n').flatMap((line) => {
    const match = LINE.exec(line);
    if (match === null) {
      return [];
    }
    const [, pid, ppid, rssKib, etime, time, path] = match;
    const elapsed = seconds(etime ?? '');
    const cpu = seconds(time ?? '');
    if (elapsed === undefined || cpu === undefined || path === undefined) {
      return [];
    }
    return [
      {
        cpuMicros: Math.round(cpu * MICROS_PER_SECOND),
        kernelStart: null,
        name: path.slice(path.lastIndexOf('/') + 1),
        pid: Number(pid),
        ppid: Number(ppid),
        rssBytes: Number(rssKib) * 1024,
        startedAt: toSecond(nowMs - elapsed * MS_PER_SECOND),
      },
    ];
  });

// A reader of the macOS process table: one `ps` run per table, and, through
// libproc, the working directory of a process, which `ps` cannot print, and
// the start the kernel recorded for each process named as a Harness, which no
// wall-clock step moves. A process whose kernel start cannot be read keeps the
// start `ps` implies.
export const createDarwinReader = ({
  cwdOf,
  kernelStartOf,
  now,
  ps,
}: {
  cwdOf: (pid: number) => Promise<string | null>;
  // Microseconds since the epoch, or null when it cannot be read.
  kernelStartOf: (pid: number) => Promise<number | null>;
  now: () => number;
  ps: (cmd: readonly string[]) => Promise<string>;
}): ProcessReader => ({
  cwdOf,
  table: async () => {
    const at = now();
    const entries = parsePs(await ps(['/bin/ps', '-axo', PS_COLUMNS]), at);
    // The entries are this read's own, so each takes its kernel start in place.
    await Promise.all(
      entries
        .filter((entry) => HARNESS_PROCESS_NAMES.has(entry.name))
        .map(async (entry) => {
          const kernelStart = await kernelStartOf(entry.pid);
          if (kernelStart !== null) {
            entry.kernelStart = kernelStart;
            entry.startedAt = toSecond(kernelStart / MICROS_PER_MS);
          }
        }),
    );
    return entries;
  },
});

const runPs = async (cmd: readonly string[]) => {
  const result = await runCommand(cmd);
  if (result.kind === 'timed out' || result.exitCode !== 0) {
    throw new Error('ps did not list the processes.');
  }
  return result.stdout;
};

export const darwinReader = (): ProcessReader =>
  createDarwinReader({
    cwdOf: darwinCwd,
    kernelStartOf: darwinKernelStart,
    now: Date.now,
    ps: runPs,
  });
