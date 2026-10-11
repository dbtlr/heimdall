import { HARNESS_NAMES, HARNESSES, isHarnessExecutable } from '../harnesses.ts';
import type { Harness } from '../harnesses.ts';
import { runCommand } from '../subprocess.ts';
import { darwinCwd, darwinKernelStart, darwinPath } from './darwin-libproc.ts';
import type { ProcessEntry, ProcessReader } from './table.ts';

// The columns the Collector asks `ps` for on macOS. `ucomm` is the accounting
// name: the file name of the executable the process runs, cut to 16 bytes,
// which the kernel sets at exec. It is not `comm`, which prints argv[0], so a
// login shell shows as `-zsh`, and no column carries a process's arguments or
// environment. `-ww` keeps `ps` from cutting a line to the terminal's width.
export const PS_COLUMNS = 'pid=,ppid=,rss=,etime=,time=,ucomm=';

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

// The Harness whose process name `name` is, if any.
const harnessNamed = (name: string) =>
  HARNESS_NAMES.find((harness) => HARNESSES[harness].process.names.includes(name));

// An accounting name that reads as a version, as Claude Code's native
// installer names each executable. The name is cut to 16 bytes, so a suffix
// may be cut short.
const VERSION_SHAPED = /^\d{1,8}\.\d{1,8}\.\d{1,8}(?:[-+].*)?$/u;

// The name of a process whose accounting name is `name` and whose executable
// is at `path`. A Harness's name stands when the executable confirms it (see
// `isHarnessExecutable`); a version-shaped name becomes the name of the
// Harness whose native install holds the executable. Any other executable
// names the process by its file name, and a name stands when its path is
// unknown.
const confirmedName = (name: string, path: string | null) => {
  if (path === null) {
    return name;
  }
  const named = harnessNamed(name);
  if (named !== undefined) {
    return isHarnessExecutable(named, path) ? name : path.slice(path.lastIndexOf('/') + 1);
  }
  const native: Harness | undefined = HARNESS_NAMES.find((harness) =>
    isHarnessExecutable(harness, path),
  );
  return native === undefined ? name : (HARNESSES[native].process.names[0] ?? name);
};

// The processes in `ps` output taken at `nowMs`. A line that is not a process
// is skipped. A start is the time `etime` ago, to the second, with no kernel
// start.
export const parsePs = (output: string, nowMs: number): ProcessEntry[] =>
  output.split('\n').flatMap((line) => {
    const match = LINE.exec(line);
    if (match === null) {
      return [];
    }
    const [, pid, ppid, rssKib, etime, time, name] = match;
    const elapsed = seconds(etime ?? '');
    const cpu = seconds(time ?? '');
    if (elapsed === undefined || cpu === undefined || name === undefined) {
      return [];
    }
    return [
      {
        cpuMicros: Math.round(cpu * MICROS_PER_SECOND),
        kernelStart: null,
        name,
        pid: Number(pid),
        ppid: Number(ppid),
        rssBytes: Number(rssKib) * 1024,
        startedAt: toSecond(nowMs - elapsed * MS_PER_SECOND),
      },
    ];
  });

// A reader of the macOS process table: one `ps` run per table, and, through
// libproc, the working directory of a process, which `ps` cannot print. For a
// process whose accounting name is a Harness's or a version, it asks for the
// executable's path to confirm the name, and for each process named as a
// Harness then, the start the kernel recorded, which no wall-clock step moves.
// A process whose kernel start cannot be read keeps the start `ps` implies.
export const createDarwinReader = ({
  cwdOf,
  kernelStartOf,
  now,
  pathOf,
  ps,
}: {
  cwdOf: (pid: number) => Promise<string | null>;
  // Microseconds since the epoch, or null when it cannot be read.
  kernelStartOf: (pid: number) => Promise<number | null>;
  now: () => number;
  // The executable's path, or null when it cannot be read.
  pathOf: (pid: number) => Promise<string | null>;
  ps: (cmd: readonly string[]) => Promise<string>;
}): ProcessReader => ({
  cwdOf,
  // `ps` prints each live process's own CPU time.
  includesReaped: false,
  table: async () => {
    const at = now();
    const entries = parsePs(await ps(['/bin/ps', '-axww', '-o', PS_COLUMNS]), at);
    // The entries are this read's own, so each candidate is named and takes its
    // kernel start in place.
    await Promise.all(
      entries
        .filter(
          (entry) => harnessNamed(entry.name) !== undefined || VERSION_SHAPED.test(entry.name),
        )
        .map(async (entry) => {
          entry.name = confirmedName(entry.name, await pathOf(entry.pid));
          if (harnessNamed(entry.name) === undefined) {
            return;
          }
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
    pathOf: darwinPath,
    ps: runPs,
  });
