import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createDarwinReader, parsePs, PS_COLUMNS } from './darwin.ts';

const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);

// `ps -axww -o pid=,ppid=,rss=,etime=,time=,ucomm=` as macOS prints it: the
// accounting name is the executable's file name, cut to 16 bytes, and may hold
// spaces. A login shell's is `zsh`, where its argv[0] would be `-zsh`.
const PS = `
    1     0  12288 12-03:04:05   0:41.07 launchd
  612     1  50000     02:00:10   1:02:03.50 claude
  613   612   2048        59:59   0:00.12 zsh
  700     1 300000        05:30  10:00.25 codex
  801     1   4096        00:07   0:00.01 Google Chrome He
 bad line
`;

test('names the columns it asks ps for, none of which is the command line or the environment', () => {
  expect(PS_COLUMNS).toBe('pid=,ppid=,rss=,etime=,time=,ucomm=');
});

test('a name with spaces is read whole, and is not cut at a slash', () => {
  const names = parsePs(PS, NOW).map((p) => p.name);

  expect(names).toEqual(['launchd', 'claude', 'zsh', 'codex', 'Google Chrome He']);
  expect(parsePs('  9  1  1  00:01  0:00.00 a/b c\n', NOW)[0]?.name).toBe('a/b c');
});

test('reads each process: its accounting name, parent, memory in KiB, CPU time, and start', () => {
  expect(parsePs(PS, NOW)).toEqual([
    {
      cpuMicros: 41_070_000,
      kernelStart: null,
      name: 'launchd',
      pid: 1,
      ppid: 0,
      rssBytes: 12_288 * 1024,
      // 12 days, 3 hours, 4 minutes, 5 seconds before NOW.
      startedAt: NOW - ((12 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000,
    },
    {
      cpuMicros: 3_723_500_000,
      kernelStart: null,
      name: 'claude',
      pid: 612,
      ppid: 1,
      rssBytes: 50_000 * 1024,
      startedAt: NOW - (2 * 3600 + 10) * 1000,
    },
    {
      cpuMicros: 120_000,
      kernelStart: null,
      name: 'zsh',
      pid: 613,
      ppid: 612,
      rssBytes: 2048 * 1024,
      startedAt: NOW - 59 * 60_000 - 59_000,
    },
    {
      cpuMicros: 600_250_000,
      kernelStart: null,
      name: 'codex',
      pid: 700,
      ppid: 1,
      rssBytes: 300_000 * 1024,
      startedAt: NOW - (5 * 60 + 30) * 1000,
    },
    {
      cpuMicros: 10_000,
      kernelStart: null,
      name: 'Google Chrome He',
      pid: 801,
      ppid: 1,
      rssBytes: 4096 * 1024,
      startedAt: NOW - 7000,
    },
  ]);
});

test('reads the table with one ps run, and the working directory of one process with the cwd reader', async () => {
  const runs: (readonly string[])[] = [];
  const cwds: number[] = [];
  const reader = createDarwinReader({
    cwdOf: (pid) => {
      cwds.push(pid);
      return Promise.resolve(pid === 612 ? '/Users/operator/project' : null);
    },
    kernelStartOf: () => Promise.resolve(null),
    now: () => NOW,
    ps: (cmd) => {
      runs.push(cmd);
      return Promise.resolve(PS);
    },
  });

  const table = await reader.table();

  expect(runs).toEqual([['/bin/ps', '-axww', '-o', PS_COLUMNS]]);
  expect(table).toHaveLength(5);
  expect(cwds).toEqual([]);
  expect(await reader.cwdOf(612)).toBe('/Users/operator/project');
  expect(await reader.cwdOf(1)).toBeNull();
});

test('the macOS readers name no command-line or environment source, and run no lsof', async () => {
  for (const file of ['darwin.ts', 'darwin-libproc.ts']) {
    // oxlint-disable-next-line no-await-in-loop -- two small files.
    const text = await readFile(join(import.meta.dir, file), 'utf8');

    expect(text).not.toMatch(/cmdline|\benviron\b|lsof|\bargs=|\bcommand=|\bcomm=/u);
  }
});

test('a start from the elapsed time is to the second, however far into the second the table is read', () => {
  const [launchd] = parsePs(PS, NOW + 700);

  expect(launchd?.startedAt).toBe(NOW - ((12 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000);
});

test("a Harness process's start is the kernel's, to the second, and the elapsed time stands in when the kernel will not say", async () => {
  const asked: number[] = [];
  // 2 hours and 10.4 seconds before NOW, in microseconds.
  const kernel = (NOW - 7_210_400) * 1000;
  const reader = createDarwinReader({
    cwdOf: () => Promise.resolve(null),
    kernelStartOf: (pid) => {
      asked.push(pid);
      return Promise.resolve(pid === 612 ? kernel : null);
    },
    now: () => NOW,
    ps: () => Promise.resolve(PS),
  });

  const table = await reader.table();

  expect(asked).toEqual([612, 700]);
  expect(table.find((p) => p.pid === 612)).toMatchObject({
    kernelStart: kernel,
    startedAt: NOW - 7_211_000,
  });
  expect(table.find((p) => p.pid === 700)).toMatchObject({
    kernelStart: null,
    startedAt: NOW - (5 * 60 + 30) * 1000,
  });
});
