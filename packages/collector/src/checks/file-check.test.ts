import { expect, test } from 'bun:test';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { checkFile } from './file-check.ts';

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
