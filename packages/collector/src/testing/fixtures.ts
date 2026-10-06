import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A fresh state directory that removes itself when disposed: `await using dir = await tempStateDir()`.
export const tempStateDir = async () => {
  const path = await mkdtemp(join(tmpdir(), 'heimdall-collector-'));
  return {
    path,
    [Symbol.asyncDispose]: () => rm(path, { force: true, recursive: true }),
  };
};
