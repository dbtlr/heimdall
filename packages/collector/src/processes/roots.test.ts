import { expect, test } from 'bun:test';

import { findHarnessRoots } from './roots.ts';
import type { ProcessEntry } from './table.ts';

const proc = (
  pid: number,
  ppid: number,
  name: string,
  { cpuMicros = 0, rssBytes = 0 }: { cpuMicros?: number; rssBytes?: number } = {},
): ProcessEntry => ({
  cpuMicros,
  kernelStart: pid,
  name,
  pid,
  ppid,
  reapedCpuMicros: 0,
  rssBytes,
  startedAt: 1_000 * pid,
});

test('a Harness process whose parent is not a Harness process is a root, with its tree summed', () => {
  const claude = proc(10, 1, 'claude', { cpuMicros: 100, rssBytes: 1000 });
  const table = [
    proc(1, 0, 'init'),
    claude,
    proc(11, 10, 'zsh', { cpuMicros: 10, rssBytes: 100 }),
    proc(12, 11, 'bun', { cpuMicros: 1000, rssBytes: 10_000 }),
    proc(20, 1, 'sshd', { cpuMicros: 5, rssBytes: 5 }),
  ];

  expect(findHarnessRoots(table)).toEqual([
    {
      cpuMicros: 1110,
      enclosing: undefined,
      entry: claude,
      harness: 'claude-code',
      reapedCpuMicros: 0,
      rssBytes: 11_100,
    },
  ]);
});

test('a root can sit under an SDK host that is not a Harness', () => {
  const table = [
    proc(1, 0, 'init'),
    proc(5, 1, 'node-MainThread'),
    proc(10, 5, 'claude', { cpuMicros: 7 }),
    proc(11, 5, 'claude', { cpuMicros: 9 }),
  ];

  expect(findHarnessRoots(table).map((r) => r.entry.pid)).toEqual([10, 11]);
});

test('a Harness process under a process of the same Harness belongs to its tree and is not a root', () => {
  const codex = proc(10, 1, 'codex', { cpuMicros: 1 });
  const table = [
    codex,
    proc(11, 10, 'codex', { cpuMicros: 2 }),
    proc(12, 11, 'codex', { cpuMicros: 4 }),
  ];

  expect(findHarnessRoots(table)).toEqual([
    {
      cpuMicros: 7,
      enclosing: undefined,
      entry: codex,
      harness: 'codex',
      reapedCpuMicros: 0,
      rssBytes: 0,
    },
  ]);
});

test('a Harness started by another Harness through a shell is its own root, and its tree is not counted twice', () => {
  const table = [
    proc(10, 1, 'claude', { cpuMicros: 1, rssBytes: 1 }),
    proc(11, 10, 'zsh', { cpuMicros: 2, rssBytes: 2 }),
    proc(12, 11, 'claude', { cpuMicros: 4, rssBytes: 4 }),
    proc(13, 12, 'git', { cpuMicros: 8, rssBytes: 8 }),
  ];

  const roots = findHarnessRoots(table);

  expect(roots.map((r) => [r.entry.pid, r.cpuMicros, r.rssBytes, r.enclosing])).toEqual([
    [10, 3, 3, undefined],
    [12, 12, 12, { harness: 'claude-code', pid: 10 }],
  ]);
});

test('a Harness started directly by a different Harness is a root of its own', () => {
  const table = [proc(10, 1, 'codex', { cpuMicros: 1 }), proc(11, 10, 'claude', { cpuMicros: 2 })];

  expect(findHarnessRoots(table).map((r) => [r.harness, r.entry.pid, r.cpuMicros])).toEqual([
    ['claude-code', 11, 2],
    ['codex', 10, 1],
  ]);
});

test('a process only matches a Harness by its exact executable name', () => {
  const table = [proc(10, 1, 'claude-proxy'), proc(11, 1, 'node'), proc(12, 1, 'Claude')];

  expect(findHarnessRoots(table)).toEqual([]);
});

test('an orphan whose parent is missing from the table is a root, and a loop in the table ends', () => {
  const table = [proc(10, 999, 'codex'), proc(20, 21, 'claude'), proc(21, 20, 'zsh')];

  expect(findHarnessRoots(table).map((r) => r.entry.pid)).toEqual([20, 10]);
});

test('an empty table has no roots', () => {
  expect(findHarnessRoots([])).toEqual([]);
});
