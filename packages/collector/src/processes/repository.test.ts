import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { repositoryOf } from './repository.ts';

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'heimdall-repository-')));
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

const dir = async (...parts: string[]) => {
  const path = join(root, ...parts);
  await mkdir(path, { recursive: true });
  return path;
};

test('a working directory at the root of a repository belongs to it', async () => {
  const repo = await dir('project');
  await dir('project', '.git');

  expect(await repositoryOf(repo)).toBe(repo);
});

test('a subdirectory belongs to the repository above it', async () => {
  const repo = await dir('project');
  await dir('project', '.git');
  const deep = await dir('project', 'packages', 'app');

  expect(await repositoryOf(deep)).toBe(repo);
});

test('a linked worktree belongs to the repository whose worktree it was added to', async () => {
  const repo = await dir('project');
  const gitdir = await dir('project', '.git', 'worktrees', 'feature');
  await writeFile(join(gitdir, 'commondir'), '../..\n');
  const linked = await dir('elsewhere', 'feature');
  await writeFile(join(linked, '.git'), `gitdir: ${gitdir}\n`);

  expect(await repositoryOf(linked)).toBe(repo);
  expect(await repositoryOf(await dir('elsewhere', 'feature', 'src'))).toBe(repo);
});

test('a linked worktree with a relative gitdir resolves it from the worktree', async () => {
  const repo = await dir('project');
  const gitdir = await dir('project', '.git', 'worktrees', 'feature');
  await writeFile(join(gitdir, 'commondir'), '../..');
  const linked = await dir('project', '.worktrees', 'feature');
  await writeFile(join(linked, '.git'), 'gitdir: ../../.git/worktrees/feature');

  expect(await repositoryOf(linked)).toBe(repo);
});

test('a worktree of a bare repository belongs to the bare repository, without its .git suffix', async () => {
  const gitdir = await dir('heimdall.git', 'worktrees', 'main');
  await writeFile(join(gitdir, 'commondir'), '../..');
  const linked = await dir('trees', 'main');
  await writeFile(join(linked, '.git'), `gitdir: ${gitdir}`);

  expect(await repositoryOf(linked)).toBe(join(root, 'heimdall'));
});

test('a worktree of a bare repository with no .git suffix belongs to the bare directory', async () => {
  const gitdir = await dir('store', 'worktrees', 'main');
  await writeFile(join(gitdir, 'commondir'), '../..');
  const linked = await dir('trees', 'main');
  await writeFile(join(linked, '.git'), `gitdir: ${gitdir}`);

  expect(await repositoryOf(linked)).toBe(join(root, 'store'));
});

test('a submodule is its own repository', async () => {
  const outer = await dir('outer');
  await dir('outer', '.git', 'modules', 'inner');
  const inner = await dir('outer', 'vendor', 'inner');
  await writeFile(join(inner, '.git'), 'gitdir: ../../.git/modules/inner\n');

  expect(await repositoryOf(inner)).toBe(inner);
  expect(await repositoryOf(outer)).toBe(outer);
});

test('a directory outside any repository belongs to none', async () => {
  expect(await repositoryOf(await dir('plain', 'folder'))).toBeNull();
});

test('a working directory the Collector could not read belongs to none', async () => {
  expect(await repositoryOf(null)).toBeNull();
  expect(await repositoryOf(join(root, 'gone'))).toBeNull();
});

// Each unusable `.git` entry sits inside an outer repository, so a lookup that
// walked on past it would name the outer one.
const inOuterRepository = async (name: string) => {
  await dir('outer', '.git');
  return dir('outer', name);
};

test('a .git file that is not a gitdir pointer belongs to none, not to the repository above', async () => {
  const folder = await inOuterRepository('odd');
  await writeFile(join(folder, '.git'), 'not a pointer');

  expect(await repositoryOf(folder)).toBeNull();
});

test('a .git file whose gitdir is missing belongs to none', async () => {
  const folder = await inOuterRepository('dangling');
  await writeFile(join(folder, '.git'), `gitdir: ${join(root, 'missing')}`);

  expect(await repositoryOf(folder)).toBeNull();
});

test('a .git file with an empty gitdir belongs to none', async () => {
  const folder = await inOuterRepository('empty');
  await writeFile(join(folder, '.git'), 'gitdir:   \n');

  expect(await repositoryOf(folder)).toBeNull();
});

test('a FIFO named .git belongs to none and is never read', async () => {
  const folder = await inOuterRepository('fifo');
  expect(await Bun.spawn(['mkfifo', join(folder, '.git')]).exited).toBe(0);

  expect(await repositoryOf(folder)).toBeNull();
}, 2000);

test('a .git entry that is a device belongs to none', async () => {
  const folder = await inOuterRepository('device');
  await symlink('/dev/zero', join(folder, '.git'));

  expect(await repositoryOf(folder)).toBeNull();
}, 2000);

test('a commondir that is not a regular file is never read', async () => {
  const repo = await dir('project');
  const gitdir = await dir('project', '.git', 'worktrees', 'feature');
  await symlink('/dev/zero', join(gitdir, 'commondir'));
  const linked = await inOuterRepository('feature');
  await writeFile(join(linked, '.git'), `gitdir: ${gitdir}`);

  expect(await repositoryOf(linked)).not.toBe(repo);
  expect(await repositoryOf(linked)).toBeNull();
}, 2000);

// A linked worktree whose `.git` file pads its pointer with spaces after
// `gitdir:` so that the pointer's path ends `end` bytes into the file.
const paddedPointer = async (end: number) => {
  const repo = await dir('project');
  const gitdir = await dir('project', '.git', 'worktrees', 'feature');
  await writeFile(join(gitdir, 'commondir'), '../..');
  const linked = await dir('elsewhere', 'feature');
  const padding = ' '.repeat(end - GITDIR.length - Buffer.byteLength(gitdir));
  await writeFile(join(linked, '.git'), `${GITDIR}${padding}${gitdir}\n${'x'.repeat(8192)}`);
  return { linked, repo };
};

const GITDIR = 'gitdir:';

test('a pointer that ends within the first 4 KiB of its file is read', async () => {
  const { linked, repo } = await paddedPointer(4096);

  expect(await repositoryOf(linked)).toBe(repo);
});

test('a pointer is read only from the first 4 KiB of its file', async () => {
  const { linked } = await paddedPointer(4097);

  expect(await repositoryOf(linked)).toBeNull();
});

test('only the first line of a .git file is the pointer', async () => {
  const repo = await dir('project');
  const gitdir = await dir('project', '.git', 'worktrees', 'feature');
  await writeFile(join(gitdir, 'commondir'), '../..');
  const linked = await dir('elsewhere', 'feature');
  await writeFile(join(linked, '.git'), `gitdir: ${gitdir}\nsomething else\n`);

  expect(await repositoryOf(linked)).toBe(repo);
});

test('a pointer written with CRLF line endings and extra spaces is read', async () => {
  const repo = await dir('project');
  const gitdir = await dir('project', '.git', 'worktrees', 'feature');
  await writeFile(join(gitdir, 'commondir'), '../..\r\n');
  const linked = await dir('elsewhere', 'feature');
  await writeFile(join(linked, '.git'), `gitdir:   ${gitdir}  \r\n`);

  expect(await repositoryOf(linked)).toBe(repo);
});

test('a relative working directory belongs to none, even inside a repository', async () => {
  const repo = await dir('project');
  await dir('project', '.git');
  const before = process.cwd();
  process.chdir(repo);
  try {
    expect(await repositoryOf('.')).toBeNull();
    expect(await repositoryOf('src')).toBeNull();
  } finally {
    process.chdir(before);
  }
});

// A project folder that holds its bare repository as `.bare`, with a `.git`
// file pointing there and worktrees added beside it.
test('in a project folder holding a .bare repository, the folder and every worktree in it share the folder', async () => {
  const project = await dir('heimdall');
  await dir('heimdall', '.bare');
  await writeFile(join(project, '.git'), 'gitdir: ./.bare\n');
  const gitdir = await dir('heimdall', '.bare', 'worktrees', 'main');
  await writeFile(join(gitdir, 'commondir'), '../..\n');
  const main = await dir('heimdall', 'main');
  await writeFile(join(main, '.git'), `gitdir: ${gitdir}\n`);

  expect(await repositoryOf(project)).toBe(project);
  expect(await repositoryOf(main)).toBe(project);
  expect(await repositoryOf(await dir('heimdall', 'main', 'src'))).toBe(project);
});

// Known exceptions, recorded in ADR-0019: naming these right would take
// reading git's configuration.
test('a linked worktree of a repository with a separate git dir is named by that git dir', async () => {
  const work = await dir('work');
  await dir('store', 'work.git');
  await writeFile(join(work, '.git'), `gitdir: ${join(root, 'store', 'work.git')}\n`);
  const gitdir = await dir('store', 'work.git', 'worktrees', 'feature');
  await writeFile(join(gitdir, 'commondir'), '../..\n');
  const linked = await dir('trees', 'feature');
  await writeFile(join(linked, '.git'), `gitdir: ${gitdir}\n`);

  expect(await repositoryOf(work)).toBe(work);
  expect(await repositoryOf(linked)).toBe(join(root, 'store', 'work'));
});

test("a linked worktree of a submodule is named by the submodule's git dir", async () => {
  const gitdir = await dir('outer', '.git', 'modules', 'inner', 'worktrees', 'feature');
  await writeFile(join(gitdir, 'commondir'), '../..\n');
  const linked = await dir('trees', 'feature');
  await writeFile(join(linked, '.git'), `gitdir: ${gitdir}\n`);

  expect(await repositoryOf(linked)).toBe(join(root, 'outer', '.git', 'modules', 'inner'));
});
