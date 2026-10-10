import { expect, test } from 'bun:test';
import {
  appendFile,
  chmod,
  mkdir,
  open,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { checkFile } from './file-check.ts';
import type { FileSystem } from './file-check.ts';

// The SHA-256 of "hello\n", from sha256sum.
const HELLO = '5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03';

const sha = (content: string) => new Bun.CryptoHasher('sha256').update(content).digest('hex');

test('a file whose content hashes to the recorded value matches', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'a.conf');
  await writeFile(path, 'hello\n');

  expect(await checkFile(path, HELLO)).toBe('match');
});

test('a file whose content differs has drifted', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'a.conf');
  await writeFile(path, 'goodbye\n');

  expect(await checkFile(path, sha('hello\n'))).toBe('drifted');
});

test('a file that does not exist is missing, also under a path that is not a directory', async () => {
  await using dir = await tempStateDir();
  await writeFile(join(dir.path, 'plain'), 'x');

  expect(await checkFile(join(dir.path, 'gone'), sha('x'))).toBe('missing');
  expect(await checkFile(join(dir.path, 'plain', 'inside'), sha('x'))).toBe('missing');
});

test('a symbolic link is followed, and a dangling one is missing', async () => {
  await using dir = await tempStateDir();
  await writeFile(join(dir.path, 'real'), 'hello\n');
  await symlink(join(dir.path, 'real'), join(dir.path, 'link'));
  await symlink(join(dir.path, 'nowhere'), join(dir.path, 'dangling'));

  expect(await checkFile(join(dir.path, 'link'), sha('hello\n'))).toBe('match');
  expect(await checkFile(join(dir.path, 'link'), sha('other'))).toBe('drifted');
  expect(await checkFile(join(dir.path, 'dangling'), sha('hello\n'))).toBe('missing');
});

test('a directory is unreadable, not drifted', async () => {
  await using dir = await tempStateDir();
  await mkdir(join(dir.path, 'etc'));

  expect(await checkFile(join(dir.path, 'etc'), sha('x'))).toBe('unreadable');
});

test('a file the Collector may not read is unreadable', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'secret');
  await writeFile(path, 'hello\n');
  await chmod(path, 0o000);

  // Root reads any file, so the case does not exist for it.
  expect(await checkFile(path, sha('hello\n'))).toBe(
    process.getuid?.() === 0 ? 'match' : 'unreadable',
  );
});

test('a symbolic link loop is unreadable', async () => {
  await using dir = await tempStateDir();
  await symlink(join(dir.path, 'b'), join(dir.path, 'a'));
  await symlink(join(dir.path, 'a'), join(dir.path, 'b'));

  expect(await checkFile(join(dir.path, 'a'), sha('x'))).toBe('unreadable');
});

test('a named pipe is unreadable and does not block the check', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'fifo');
  await Bun.spawn(['mkfifo', path]).exited;

  expect(await checkFile(path, sha('x'))).toBe('unreadable');
});

test('a file larger than one read chunk is hashed whole', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'big');
  const content = 'abc'.repeat(1_000_000);
  await writeFile(path, content);

  expect(await checkFile(path, sha(content))).toBe('match');
});

test('an empty file hashes to the SHA-256 of nothing', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'empty');
  await writeFile(path, '');

  expect(await checkFile(path, sha(''))).toBe('match');
});

test('a device is unreadable and is not read to its end', async () => {
  // /dev/zero never ends, so reading it would hang the test.
  expect(await checkFile('/dev/zero', sha('x'))).toBe('unreadable');
});

test('a check cut short by the signal answers nothing', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'a.conf');
  await writeFile(path, 'hello\n');

  expect(await checkFile(path, HELLO, AbortSignal.abort())).toBeUndefined();
  expect(await checkFile(path, HELLO, new AbortController().signal)).toBe('match');
});

test('a check of a large file stops between chunks when the signal aborts', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'big');
  await writeFile(path, Buffer.alloc(64 * 1024 * 1024));
  const controller = new AbortController();
  const check = checkFile(path, sha('x'), controller.signal);
  // The first chunk is not read until the check yields.
  controller.abort();

  expect(await check).toBeUndefined();
});

test('a check of a huge file stops soon after the signal aborts, not when the file ends', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'sparse');
  // Four GiB of zeros that take no disk, and seconds to read.
  await writeFile(path, '');
  await truncate(path, 4 * 1024 * 1024 * 1024);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const started = performance.now();

  const verdict = await checkFile(path, sha('x'), controller.signal);

  expect(verdict).toBeUndefined();
  expect(performance.now() - started).toBeLessThan(1000);
});

test('a file that grows after it is opened is hashed only as far as it was then', async () => {
  await using dir = await tempStateDir();
  const path = join(dir.path, 'growing');
  const content = 'hello\n'.repeat(1000);
  await writeFile(path, content);
  // The file grows by 1 MiB right after the check examines the opened file.
  const growing: FileSystem = {
    open: async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      const examine = handle.stat.bind(handle);
      handle.stat = (async (...options: never[]) => {
        const size = await examine(...options);
        await appendFile(path, Buffer.alloc(1024 * 1024, 1));
        return size;
      }) as typeof handle.stat;
      return handle;
    },
    stat,
  };

  expect(await checkFile(path, sha(content), undefined, growing)).toBe('match');
});

// A file system that records the paths opened.
const watchOpens = () => {
  const opened: string[] = [];
  const watching: FileSystem = {
    open: (...args: Parameters<typeof open>) => {
      opened.push(String(args[0]));
      return open(...args);
    },
    stat,
  };
  return { opened, watching };
};

test.each(['/dev/zero', '/dev/null'])('%s is unreadable and is never opened', async (device) => {
  const { opened, watching } = watchOpens();

  expect(await checkFile(device, sha('x'), undefined, watching)).toBe('unreadable');
  expect(opened).toEqual([]);
});

test('a symbolic link to a device is unreadable and the device is never opened', async () => {
  await using dir = await tempStateDir();
  await symlink('/dev/zero', join(dir.path, 'zero'));
  const { opened, watching } = watchOpens();

  expect(await checkFile(join(dir.path, 'zero'), sha('x'), undefined, watching)).toBe('unreadable');
  expect(opened).toEqual([]);
});
