import { runCommand } from '../subprocess.ts';
import { darwinCwd } from './darwin-cwd.ts';
import type { ProcessEntry, ProcessReader } from './table.ts';

// The columns the Collector asks `ps` for on macOS. `comm` is the executable's
// path. No column carries a process's arguments or environment.
export const PS_COLUMNS = 'pid=,ppid=,rss=,etime=,time=,comm=';

const MICROS_PER_SECOND = 1_000_000;
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

// The processes in `ps` output taken at `nowMs`. A line that is not a process
// is skipped. A start is the time `etime` ago, to the second.
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
        name: path.slice(path.lastIndexOf('/') + 1),
        pid: Number(pid),
        ppid: Number(ppid),
        rssBytes: Number(rssKib) * 1024,
        startedAt: Math.floor((nowMs - elapsed * MS_PER_SECOND) / MS_PER_SECOND) * MS_PER_SECOND,
      },
    ];
  });

// A reader of the macOS process table: one `ps` run per table, and the working
// directory of a process, which `ps` cannot print, through libproc.
export const createDarwinReader = ({
  cwdOf,
  now,
  ps,
}: {
  cwdOf: (pid: number) => Promise<string | null>;
  now: () => number;
  ps: (cmd: readonly string[]) => Promise<string>;
}): ProcessReader => ({
  cwdOf,
  table: async () => {
    const at = now();
    return parsePs(await ps(['/bin/ps', '-axo', PS_COLUMNS]), at);
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
  createDarwinReader({ cwdOf: darwinCwd, now: Date.now, ps: runPs });
