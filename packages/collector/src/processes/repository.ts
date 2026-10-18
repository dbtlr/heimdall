import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { MAX_CWD_BYTES } from '@heimdall/schema';

import { isAbsent } from '../harness-installs.ts';

const GITDIR_PREFIX = 'gitdir:';

// The most of a pointer file that is read. A `gitdir:` or `commondir` pointer
// is one line naming a path, and a path is at most MAX_CWD_BYTES.
const MAX_POINTER_BYTES = 4096;

// What a path is: a directory, a regular file, null when it is missing, or
// `other` for anything else, such as a FIFO, a device, or a path that is there
// but cannot be read. Only a missing path lets the walk go further up.
const kindOf = async (path: string) => {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      return 'directory';
    }
    return info.isFile() ? 'file' : 'other';
  } catch (error) {
    return isAbsent(error) ? null : 'other';
  }
};

// The first MAX_POINTER_BYTES of a pointer file, or null when it is not a
// regular file or cannot be read. Opening without blocking and checking the
// open handle means a FIFO in a pointer's place, even one swapped in after an
// earlier check, cannot block the tick; a large file is never read whole.
const readPointer = async (path: string) => {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) {
        return null;
      }
      const buffer = Buffer.alloc(MAX_POINTER_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_POINTER_BYTES, 0);
      return buffer.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

// The repository a linked worktree's common directory stands for. A common
// directory whose name starts with a dot, such as `.git` or the `.bare` of a
// bare repository kept inside its project folder, names its parent; a bare
// repository named like `project.git` names itself without the suffix; any
// other names itself.
const repositoryOfCommonDir = (commonDir: string) => {
  const name = basename(commonDir);
  if (name.startsWith('.')) {
    return dirname(commonDir);
  }
  return name.endsWith('.git') ? commonDir.slice(0, -'.git'.length) : commonDir;
};

// Follows a `.git` file's `gitdir:` pointer, its first line. A linked
// worktree's git directory holds a `commondir` file that names the shared
// directory. A git directory without one, a submodule's or the `.bare` of a
// project folder, makes the working directory its own repository.
const repositoryOfPointer = async (workingDir: string, pointer: string) => {
  const line = pointer.split('\n')[0] ?? '';
  const target = line.startsWith(GITDIR_PREFIX) ? line.slice(GITDIR_PREFIX.length).trim() : '';
  if (target === '') {
    return null;
  }
  const gitDir = resolve(workingDir, target);
  if ((await kindOf(gitDir)) !== 'directory') {
    return null;
  }
  const commonDirFile = join(gitDir, 'commondir');
  const commonDirKind = await kindOf(commonDirFile);
  if (commonDirKind === null) {
    return workingDir;
  }
  if (commonDirKind !== 'file') {
    return null;
  }
  const commonDir = (await readPointer(commonDirFile))?.trim() ?? '';
  return commonDir === '' ? null : repositoryOfCommonDir(resolve(gitDir, commonDir));
};

// What a directory's own `.git` entry says: the repository, null when the entry
// is there but unusable, or undefined when the directory has none.
const repositoryHere = async (dir: string) => {
  const entry = join(dir, '.git');
  const kind = await kindOf(entry);
  if (kind === 'directory') {
    return dir;
  }
  if (kind === null) {
    return undefined;
  }
  return repositoryOfPointer(dir, (await readPointer(entry)) ?? '');
};

const repositoryAbove = async (dir: string): Promise<string | null> => {
  const here = await repositoryHere(dir);
  if (here !== undefined) {
    return here;
  }
  const parent = dirname(dir);
  return parent === dir ? null : repositoryAbove(parent);
};

// The absolute path of the repository a working directory belongs to, or null
// when it belongs to none or the pointer files cannot be read. This walks up to
// the first `.git` entry and follows its pointers, reading only regular files
// and only their first MAX_POINTER_BYTES; it never runs git and reads nothing
// of a repository's content (ADR-0019).
export const repositoryOf = async (cwd: string | null): Promise<string | null> => {
  if (cwd === null || !isAbsolute(cwd)) {
    return null;
  }
  const found = await repositoryAbove(resolve(cwd));
  return found !== null && Buffer.byteLength(found) <= MAX_CWD_BYTES ? found : null;
};
