import { expect, test } from 'bun:test';

import { pathWith } from './darwin-libproc.ts';
import type { ProcPidPath } from './darwin-libproc.ts';

// A `proc_pidpath` that writes `path` and returns `result`, as libproc does:
// the path's length on success, and 0 or less on failure.
const fake = (path: string, result: number) => {
  const calls: { pid: number; size: number }[] = [];
  const call: ProcPidPath = (pid, buffer, size) => {
    calls.push({ pid, size });
    buffer.write(`${path}\0`, 'utf8');
    return result;
  };
  return { call, calls };
};

test('reads the path proc_pidpath wrote, by the length it returned, from a buffer of PROC_PIDPATHINFO_MAXSIZE', () => {
  const path = '/Users/operator/.local/share/claude/versions/2.1.296';
  const { call, calls } = fake(path, Buffer.byteLength(path));

  expect(pathWith(call, 612)).toBe(path);
  expect(calls).toEqual([{ pid: 612, size: 4096 }]);
});

test('a return of 0 or less is a failure, whatever the buffer holds', () => {
  expect(pathWith(fake('/bin/zsh', 0).call, 1)).toBeNull();
  expect(pathWith(fake('/bin/zsh', -1).call, 1)).toBeNull();
});
