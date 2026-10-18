import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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

test('a .git file that is not a gitdir pointer belongs to none', async () => {
  const folder = await dir('odd');
  await writeFile(join(folder, '.git'), 'not a pointer');

  expect(await repositoryOf(folder)).toBeNull();
});

test('a .git file whose gitdir is missing belongs to none', async () => {
  const folder = await dir('dangling');
  await writeFile(join(folder, '.git'), `gitdir: ${join(root, 'missing')}`);

  expect(await repositoryOf(folder)).toBeNull();
});
