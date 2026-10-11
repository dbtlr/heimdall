import { readdir, readFile, readlink } from 'node:fs/promises';
import { basename } from 'node:path';

import { HARNESS_NAMES, HARNESSES, isHarnessExecutable } from '../harnesses.ts';
import { readCommand } from '../subprocess.ts';
import type { ProcessEntry, ProcessReader } from './table.ts';

// All the Collector may do to /proc: list a directory, read a text file, and
// read where a link points.
export type ProcFs = {
  listDir: (path: string) => Promise<string[]>;
  readLink: (path: string) => Promise<string>;
  readText: (path: string) => Promise<string>;
};

export const nodeProcFs: ProcFs = {
  listDir: (path) => readdir(path),
  readLink: (path) => readlink(path),
  readText: (path) => readFile(path, 'utf8'),
};

const MICROS_PER_SECOND = 1_000_000;

// The most /proc files a table read holds open at once, well under a usual
// limit of 1024 file descriptors, whatever the number of processes.
const MAX_OPEN_READS = 64;

// `task` over every item, at most `limit` at a time, in the items' order.
const mapBounded = async <Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item) => Promise<Result>,
): Promise<Result[]> => {
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next; index < items.length; index = next) {
      next += 1;
      const item = items[index];
      if (item !== undefined) {
        // oxlint-disable-next-line no-await-in-loop -- each worker reads one at a time.
        results[index] = await task(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
};
const MS_PER_SECOND = 1000;

// Fields of /proc/<pid>/stat after the command name, by proc(5)'s field number
// minus three, since the list here starts at the state.
const PPID = 1;
const UTIME = 11;
const STIME = 12;
const CUTIME = 13;
const CSTIME = 14;
const START_TIME = 19;
const RSS = 21;

// The Harness whose process name a command name is, if any.
const harnessNamed = (comm: string) =>
  HARNESS_NAMES.find((harness) => HARNESSES[harness].process.names.includes(comm));

// The process behind a stat line, or undefined when the line is not one. The
// command name is in parentheses and may hold spaces and parentheses itself,
// so it ends at the last closing one.
const parseStat = (text: string) => {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 1 || close < open) {
    return undefined;
  }
  const pid = Number(text.slice(0, open).trim());
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  const field = (index: number) => Number(fields[index]);
  const numbers = [PPID, UTIME, STIME, CUTIME, CSTIME, START_TIME, RSS].map(field);
  if (!Number.isInteger(pid) || numbers.some((n) => !Number.isFinite(n))) {
    return undefined;
  }
  return {
    comm: text.slice(open + 1, close),
    cstime: field(CSTIME),
    cutime: field(CUTIME),
    pid,
    ppid: field(PPID),
    rssPages: field(RSS),
    startTicks: field(START_TIME),
    stime: field(STIME),
    utime: field(UTIME),
  };
};

// A reader of the process table through /proc, reading only each process's
// `stat` and, for a process whose command name could be a Harness's, where its
// `exe` and `cwd` links point. It never opens the files that hold a process's
// command line or environment (ADR-0002).
//
// CPU time is user plus system for the process and for the children it has
// waited for, so the time of a descendant that has exited still counts toward
// its parent's tree. A process whose command name is a Harness's keeps that
// name when its executable confirms it (see `isHarnessExecutable`), such as
// Claude Code's native install, whose executable is named by its version. One
// whose executable does not, such as a script run as `claude` by `node`, is
// named by the executable's file name, `node`. The command name stands in when
// the link cannot be read.
export const createLinuxReader = ({
  clockTicks,
  fs = nodeProcFs,
  pageSize,
  root = '/proc',
}: {
  clockTicks: number;
  fs?: ProcFs;
  pageSize: number;
  root?: string;
}): ProcessReader => {
  const nameOf = async (pid: number, comm: string) => {
    const harness = harnessNamed(comm);
    if (harness === undefined) {
      return comm;
    }
    try {
      const exe = (await fs.readLink(`${root}/${String(pid)}/exe`)).replace(/ \(deleted\)$/u, '');
      return isHarnessExecutable(harness, exe) ? comm : basename(exe);
    } catch {
      return comm;
    }
  };

  const bootSeconds = async () => {
    const line = (await fs.readText(`${root}/stat`))
      .split('\n')
      .find((l) => l.startsWith('btime '));
    const seconds = Number(line?.slice('btime '.length));
    if (!Number.isFinite(seconds)) {
      throw new Error(`${root}/stat has no boot time.`);
    }
    return seconds;
  };

  const entryOf = async (pid: string, boot: number): Promise<ProcessEntry[]> => {
    try {
      const stat = parseStat(await fs.readText(`${root}/${pid}/stat`));
      if (stat === undefined) {
        return [];
      }
      return [
        {
          cpuMicros: Math.round(
            ((stat.utime + stat.stime + stat.cutime + stat.cstime) * MICROS_PER_SECOND) /
              clockTicks,
          ),
          kernelStart: stat.startTicks,
          name: await nameOf(stat.pid, stat.comm),
          pid: stat.pid,
          ppid: stat.ppid,
          rssBytes: stat.rssPages * pageSize,
          startedAt: (boot + Math.floor(stat.startTicks / clockTicks)) * MS_PER_SECOND,
        },
      ];
    } catch {
      // The process exited between the listing and the read.
      return [];
    }
  };

  return {
    cwdOf: async (pid) => {
      try {
        return await fs.readLink(`${root}/${String(pid)}/cwd`);
      } catch {
        return null;
      }
    },
    table: async () => {
      const [boot, names] = await Promise.all([bootSeconds(), fs.listDir(root)]);
      const pids = names.filter((name) => /^[1-9]\d*$/u.test(name));
      return (await mapBounded(pids, MAX_OPEN_READS, (pid) => entryOf(pid, boot))).flat();
    },
  };
};

// One of the kernel's constants, such as `PAGESIZE`, from `getconf`.
const sysconf = async (name: string, fallback: number) => {
  const value = Number((await readCommand(['/usr/bin/getconf', name]).catch(() => '')).trim());
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

// The reader of this System, with the kernel's page size and clock ticks per
// second, which /proc counts in and which hold for the life of a boot.
export const linuxReader = async (): Promise<ProcessReader> =>
  createLinuxReader({
    clockTicks: await sysconf('CLK_TCK', 100),
    pageSize: await sysconf('PAGESIZE', 4096),
  });
