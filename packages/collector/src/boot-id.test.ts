import { expect, test } from 'bun:test';

import { darwinBootId, linuxBootId } from './boot-id.ts';

test("Linux's boot is the kernel's boot_id", async () => {
  const read: string[] = [];

  const id = await linuxBootId((path) => {
    read.push(path);
    return Promise.resolve('4f1c2d3e-aaaa-bbbb-cccc-123456789abc\n');
  });

  expect(id).toBe('4f1c2d3e-aaaa-bbbb-cccc-123456789abc');
  expect(read).toEqual(['/proc/sys/kernel/random/boot_id']);
});

test("macOS's boot is the kernel's boot session UUID", async () => {
  const ran: string[][] = [];

  const id = await darwinBootId((cmd) => {
    ran.push([...cmd]);
    return Promise.resolve('9A8B7C6D-1111-2222-3333-444455556666\n');
  });

  expect(id).toBe('9A8B7C6D-1111-2222-3333-444455556666');
  expect(ran).toEqual([['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid']]);
});

test('an empty boot is an error, never a boot every check shares', () => {
  expect(linuxBootId(() => Promise.resolve(' \n'))).rejects.toThrow('no boot identity');
  expect(darwinBootId(() => Promise.resolve(''))).rejects.toThrow('no boot identity');
});
