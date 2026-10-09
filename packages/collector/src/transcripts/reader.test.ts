import { describe, expect, test } from 'bun:test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { openRegular } from './reader.ts';

// Whatever a scan finds in a file's place between listing it and opening it.
describe('opening a file to read', () => {
  test('opens a regular file', async () => {
    await using dir = await tempStateDir();
    await writeFile(join(dir.path, 'a.jsonl'), '{"a":1}\n');

    const opened = await openRegular(join(dir.path, 'a.jsonl'));
    await opened?.handle.close();

    expect(opened?.seen.size).toBe(8);
  });

  test('does not follow a symbolic link', async () => {
    await using dir = await tempStateDir();
    await writeFile(join(dir.path, 'secret'), 'outside\n');
    await symlink(join(dir.path, 'secret'), join(dir.path, 'a.jsonl'));

    expect(await openRegular(join(dir.path, 'a.jsonl'))).toBeUndefined();
  });

  test('does not block on a FIFO', async () => {
    await using dir = await tempStateDir();
    const fifo = join(dir.path, 'a.jsonl');
    await Bun.spawn(['mkfifo', fifo]).exited;

    expect(await openRegular(fifo)).toBeUndefined();
  });

  test('skips a directory', async () => {
    await using dir = await tempStateDir();
    await mkdir(join(dir.path, 'a.jsonl'));

    expect(await openRegular(join(dir.path, 'a.jsonl'))).toBeUndefined();
  });

  test('skips a file that is gone', async () => {
    await using dir = await tempStateDir();

    expect(await openRegular(join(dir.path, 'a.jsonl'))).toBeUndefined();
  });
});
