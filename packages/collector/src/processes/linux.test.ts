import { expect, test } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { createLinuxReader, nodeProcFs } from './linux.ts';
import type { ProcFs } from './linux.ts';
import { createProcessTracker } from './tracker.ts';

const PAGE_SIZE = 4096;
const CLOCK_TICKS = 100;
const BOOT_SECONDS = 1_759_000_000;
const SECRET = 'sk-live-do-not-leak';

// A /proc/<pid>/stat line: fields after the command are numbered from the
// state (field 3 of proc(5)).
const stat = (
  pid: number,
  comm: string,
  {
    cstime = 0,
    cutime = 0,
    ppid,
    rssPages = 0,
    startTicks = 0,
    stime = 0,
    utime = 0,
  }: {
    cstime?: number;
    cutime?: number;
    ppid: number;
    rssPages?: number;
    startTicks?: number;
    stime?: number;
    utime?: number;
  },
) => {
  const after = Array.from({ length: 50 }, () => '0');
  // state is index 0, so field n sits at index n - 3.
  after[0] = 'S';
  after[1] = String(ppid);
  after[11] = String(utime);
  after[12] = String(stime);
  after[13] = String(cutime);
  after[14] = String(cstime);
  after[19] = String(startTicks);
  after[21] = String(rssPages);
  return `${String(pid)} (${comm}) ${after.join(' ')}\n`;
};

type Fixture = { cwd?: string; exe?: string; stat: string };

// A /proc made of `processes`, with an argument and environment file beside
// every process holding text that must never be read, and a log of the paths
// opened.
const fixtureFs = (processes: Record<number, Fixture>) => {
  const opened: string[] = [];
  const files = new Map<string, string>([
    ['/proc/stat', `cpu 1 2 3\nbtime ${String(BOOT_SECONDS)}\n`],
  ]);
  const links = new Map<string, string>();
  for (const [pid, p] of Object.entries(processes)) {
    files.set(`/proc/${pid}/stat`, p.stat);
    files.set(`/proc/${pid}/cmdline`, `claude\0--api-key\0${SECRET}\0`);
    files.set(`/proc/${pid}/environ`, `ANTHROPIC_API_KEY=${SECRET}\0`);
    if (p.exe !== undefined) {
      links.set(`/proc/${pid}/exe`, p.exe);
    }
    if (p.cwd !== undefined) {
      links.set(`/proc/${pid}/cwd`, p.cwd);
    }
  }
  const fs: ProcFs = {
    listDir: (path) => {
      opened.push(path);
      return Promise.resolve(['self', 'net', ...Object.keys(processes)]);
    },
    readLink: (path) => {
      opened.push(path);
      const target = links.get(path);
      return target === undefined ? Promise.reject(new Error('EACCES')) : Promise.resolve(target);
    },
    readText: (path) => {
      opened.push(path);
      const text = files.get(path);
      return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text);
    },
  };
  return { files, fs, opened };
};

const readerOf = (fs: ProcFs) =>
  createLinuxReader({ clockTicks: CLOCK_TICKS, fs, pageSize: PAGE_SIZE });

test('reads a process from its stat line: name, parent, CPU time with reaped children, memory, and start', async () => {
  const { fs } = fixtureFs({
    42: {
      stat: stat(42, 'claude', {
        cstime: 50,
        cutime: 150,
        ppid: 7,
        rssPages: 100,
        startTicks: 12_345,
        stime: 200,
        utime: 300,
      }),
    },
  });

  expect(await readerOf(fs).table()).toEqual([
    {
      // (300 + 200 + 150 + 50) ticks at 100 per second.
      cpuMicros: 7_000_000,
      // The kernel's start, in clock ticks since boot.
      kernelStart: 12_345,
      name: 'claude',
      pid: 42,
      ppid: 7,
      // (150 + 50) ticks of children it waited for.
      reapedCpuMicros: 2_000_000,
      rssBytes: 100 * PAGE_SIZE,
      // btime plus 123.45 s, to the second.
      startedAt: (BOOT_SECONDS + 123) * 1000,
    },
  ]);
});

test('a command name with spaces and parentheses is read whole', async () => {
  const { fs } = fixtureFs({ 9: { stat: stat(9, 'a (b) c', { ppid: 1 }) } });

  expect((await readerOf(fs).table())[0]?.name).toBe('a (b) c');
});

test("a process's name is its executable's file name, and its command name when the link cannot be read", async () => {
  const { fs } = fixtureFs({
    1: { exe: '/opt/tools/claude/2.1.296/claude', stat: stat(1, 'claude', { ppid: 0 }) },
    2: { exe: '/opt/bin/codex (deleted)', stat: stat(2, 'codex', { ppid: 0 }) },
    3: { stat: stat(3, 'codex', { ppid: 0 }) },
    4: { exe: '/usr/bin/node', stat: stat(4, 'claude', { ppid: 0 }) },
    5: { stat: stat(5, 'sleep', { ppid: 0 }) },
  });

  const names = (await readerOf(fs).table()).map((p) => p.name);

  expect(names).toEqual(['claude', 'codex', 'codex', 'node', 'sleep']);
});

test("Claude Code's native install, whose executable is named by its version, is named by its command name", async () => {
  const { fs } = fixtureFs({
    1: {
      exe: '/home/operator/.local/share/claude/versions/2.1.296',
      stat: stat(1, 'claude', { ppid: 0 }),
    },
    2: { exe: '/srv/data/claude/versions/2.1.300 (deleted)', stat: stat(2, 'claude', { ppid: 0 }) },
    3: {
      exe: '/home/operator/.local/share/other/versions/2.1.296',
      stat: stat(3, 'claude', { ppid: 0 }),
    },
    4: {
      exe: '/home/operator/.local/share/claude/versions/2.1.296',
      stat: stat(4, 'codex', { ppid: 0 }),
    },
  });

  const names = (await readerOf(fs).table()).map((p) => p.name);

  expect(names).toEqual(['claude', 'claude', '2.1.296', '2.1.296']);
});

test('a process that vanishes or cannot be read is left out, and so is a non-process entry', async () => {
  const { fs } = fixtureFs({
    1: { stat: stat(1, 'init', { ppid: 0 }) },
    2: { stat: 'garbage' },
  });

  expect((await readerOf(fs).table()).map((p) => p.pid)).toEqual([1]);
});

test('reads at most 64 stat files at once, so a large process table does not run out of file descriptors', async () => {
  const processes = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [i + 1, { stat: stat(i + 1, 'sleep', { ppid: 0 }) }]),
  );
  const { fs } = fixtureFs(processes);
  let open = 0;
  let most = 0;
  const counting: ProcFs = {
    ...fs,
    readText: async (path) => {
      open += 1;
      most = Math.max(most, open);
      await Bun.sleep(0);
      open -= 1;
      return fs.readText(path);
    },
  };

  const table = await readerOf(counting).table();

  expect(table).toHaveLength(300);
  expect(most).toBeLessThanOrEqual(64);
  expect(most).toBeGreaterThan(1);
});

test('reads the working directory through the cwd link, and answers null when it cannot be read', async () => {
  const { fs } = fixtureFs({
    1: { cwd: '/work/project', stat: stat(1, 'claude', { ppid: 0 }) },
    2: { stat: stat(2, 'claude', { ppid: 0 }) },
  });
  const reader = readerOf(fs);

  expect(await reader.cwdOf(1)).toBe('/work/project');
  expect(await reader.cwdOf(2)).toBeNull();
});

test('reads executable links only for processes that could be a Harness', async () => {
  const { fs, opened } = fixtureFs({
    1: { exe: '/usr/bin/sleep', stat: stat(1, 'sleep', { ppid: 0 }) },
    2: { exe: '/opt/claude', stat: stat(2, 'claude', { ppid: 0 }) },
  });

  await readerOf(fs).table();

  expect(opened.filter((p) => p.endsWith('/exe'))).toEqual(['/proc/2/exe']);
});

test('never opens a process command line or environment, and no text from them reaches a section', async () => {
  const { fs, opened } = fixtureFs({
    10: {
      cwd: '/work/project',
      exe: '/opt/claude/2.1.296/claude',
      stat: stat(10, 'claude', { ppid: 1, startTicks: 100, utime: 50 }),
    },
    11: { stat: stat(11, 'zsh', { ppid: 10 }) },
  });
  const tracker = createProcessTracker({ now: () => 1_000, reader: readerOf(fs) });

  await tracker.tick();
  const section = tracker.latest();

  expect(opened.length).toBeGreaterThan(0);
  expect(opened.filter((p) => /cmdline|environ/u.test(p))).toEqual([]);
  expect(JSON.stringify(section)).not.toContain(SECRET);
  expect(section?.processes).toHaveLength(1);
});

test('the Linux reader names no command-line or environment file', async () => {
  const text = await Bun.file(join(import.meta.dir, 'linux.ts')).text();

  expect(text).not.toMatch(/cmdline|\benviron\b/u);
});

test('the real filesystem reader lists, reads, and follows links', async () => {
  await using dir = await tempStateDir();
  await mkdir(join(dir.path, '7'));
  await writeFile(join(dir.path, '7', 'stat'), 'x');
  await symlink('/work/project', join(dir.path, '7', 'cwd'));
  const fs = nodeProcFs;

  expect(await fs.listDir(dir.path)).toEqual(['7']);
  expect(await fs.readText(join(dir.path, '7', 'stat'))).toBe('x');
  expect(await fs.readLink(join(dir.path, '7', 'cwd'))).toBe('/work/project');
});

test('a wall-clock step that moves the boot time does not split a running process, and its start stays as first seen', async () => {
  const { files, fs } = fixtureFs({
    10: { exe: '/opt/bin/claude', stat: stat(10, 'claude', { ppid: 1, startTicks: 5000 }) },
  });
  let now = (BOOT_SECONDS + 3600) * 1000;
  const tracker = createProcessTracker({ now: () => now, reader: readerOf(fs) });
  await tracker.tick();
  files.set('/proc/stat', `cpu 1 2 3\nbtime ${String(BOOT_SECONDS + 30)}\n`);
  now += 15_000;

  await tracker.tick();

  expect(tracker.latest()?.processes).toEqual([
    expect.objectContaining({ pid: 10, startedAt: (BOOT_SECONDS + 50) * 1000 }),
  ]);
  expect(tracker.latest()?.processes[0]).not.toHaveProperty('endedAt');
});

test('a pid reused within the same second is a new process, told apart by its start in clock ticks', async () => {
  const { files, fs } = fixtureFs({
    10: { exe: '/opt/bin/claude', stat: stat(10, 'claude', { ppid: 1, startTicks: 5010 }) },
  });
  const tracker = createProcessTracker({ now: () => 1_000, reader: readerOf(fs) });
  await tracker.tick();
  files.set('/proc/10/stat', stat(10, 'claude', { ppid: 1, startTicks: 5090 }));

  await tracker.tick();

  expect(tracker.latest()?.processes.map((p) => p.endedAt !== undefined)).toEqual([true, false]);
});
