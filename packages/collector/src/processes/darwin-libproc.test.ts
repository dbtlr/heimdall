import { expect, test } from 'bun:test';

import { darwinProcessIdentity, pathWith, uniqueIdWith } from './darwin-libproc.ts';
import type { ProcPidInfo, ProcPidPath } from './darwin-libproc.ts';

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

test('cross-user lifetime identity reads all 64 bits of PROC_PIDUNIQIDENTIFIERINFO', () => {
  const calls: { pid: number; flavor: number; arg: bigint; size: number }[] = [];
  const info: ProcPidInfo = (pid, flavor, arg, buffer, size) => {
    calls.push({ arg, flavor, pid, size });
    buffer.writeBigUInt64LE(18_446_744_073_709_551_615n, 16);
    return 56;
  };
  expect(uniqueIdWith(info, 42)).toBe('18446744073709551615');
  expect(calls).toEqual([{ arg: 0n, flavor: 17, pid: 42, size: 56 }]);
});

test('a denied, short, or zero unique identifier remains unknown', () => {
  expect(uniqueIdWith(() => 0, 42)).toBeNull();
  expect(uniqueIdWith(() => 24, 42)).toBeNull();
  expect(uniqueIdWith(() => 56, 42)).toBeNull();
});

test.skipIf(process.platform !== 'darwin')(
  'native macOS reads stable lifetime identifiers for this process and root-owned launchd',
  async () => {
    const own = await darwinProcessIdentity(process.pid);
    const rootOwned = await darwinProcessIdentity(1);
    expect(own).toMatch(/^[1-9]\d*$/u);
    expect(rootOwned).toMatch(/^[1-9]\d*$/u);
    expect(rootOwned).not.toBe(own);
    expect(await darwinProcessIdentity(process.pid)).toBe(own);
    expect(await darwinProcessIdentity(2_147_483_647)).toBeNull();
  },
);
