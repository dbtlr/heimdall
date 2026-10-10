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

// A sections source with nothing to send, for tests that are not about records or runs.
export const NO_SECTIONS = { pending: () => Promise.resolve({}) };

// A Collector whose time zone is not known, for tests that are not about it.
export const NO_TIME_ZONE = () => undefined;
