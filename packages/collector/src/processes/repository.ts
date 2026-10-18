import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { MAX_CWD_BYTES } from '@heimdall/schema';

const GITDIR_PREFIX = 'gitdir:';

const readText = async (path: string) => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

const kindOf = async (path: string) => {
  try {
    const info = await stat(path);
    return info.isDirectory() ? 'directory' : 'file';
  } catch {
    return null;
  }
};

// The repository a linked worktree or bare repository's common directory
// stands for: the parent of a `.git` directory, otherwise the directory itself
// with a `.git` suffix taken off its name.
const repositoryOfCommonDir = (commonDir: string) => {
  if (basename(commonDir) === '.git') {
    return dirname(commonDir);
  }
  return commonDir.endsWith('.git') && commonDir.length > '.git'.length
    ? commonDir.slice(0, -'.git'.length)
    : commonDir;
};

// Follows a `.git` file's `gitdir:` pointer. A linked worktree's git directory
// holds a `commondir` file that names the shared directory; a submodule's does
// not, and the submodule is its own repository.
const repositoryOfPointer = async (workingDir: string, pointer: string) => {
  const line = pointer.split('\n')[0]?.trim() ?? '';
  if (!line.startsWith(GITDIR_PREFIX)) {
    return null;
  }
  const gitDir = resolve(workingDir, line.slice(GITDIR_PREFIX.length).trim());
  if ((await kindOf(gitDir)) !== 'directory') {
    return null;
  }
  const commonDir = (await readText(join(gitDir, 'commondir')))?.trim();
  return commonDir === undefined || commonDir === ''
    ? workingDir
    : repositoryOfCommonDir(resolve(gitDir, commonDir));
};

// What a directory's own `.git` entry says: the repository, null when the entry
// is there but unusable, or undefined when the directory has none.
const repositoryHere = async (dir: string) => {
  const entry = join(dir, '.git');
  const kind = await kindOf(entry);
  if (kind === 'directory') {
    return dir;
  }
  if (kind === 'file') {
    return repositoryOfPointer(dir, (await readText(entry)) ?? '');
  }
  return undefined;
};

const repositoryAbove = async (dir: string): Promise<string | null> => {
  const here = await repositoryHere(dir);
  if (here !== undefined) {
    return here;
  }
  const parent = dirname(dir);
  return parent === dir ? null : repositoryAbove(parent);
};

// The absolute path of the main worktree of the repository a working directory
// belongs to, or null when it belongs to none or the pointer files cannot be
// read. This walks up to the first `.git` entry and follows its pointers; it
// never runs git and reads nothing of a repository's content (ADR-0019).
export const repositoryOf = async (cwd: string | null): Promise<string | null> => {
  if (cwd === null || !isAbsolute(cwd)) {
    return null;
  }
  const found = await repositoryAbove(resolve(cwd));
  return found !== null && Buffer.byteLength(found) <= MAX_CWD_BYTES ? found : null;
};
