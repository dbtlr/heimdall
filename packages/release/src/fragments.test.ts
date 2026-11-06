import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fragmentCheckProblems, pendingFragments, plainTextProblems } from './fragments.ts';

test('a check that passed every pending fragment, with no warning, is no problem', () => {
  expect(fragmentCheckProblems({ checked: 2, kind: 'passed', warnings: [] }, 2, [])).toEqual([]);
});

test('a warning Loom printed on a passing check fails the guard even when the counts match', () => {
  expect(
    fragmentCheckProblems({ checked: 1, kind: 'passed', warnings: ['Skipped something.'] }, 1, []),
  ).toEqual(['Skipped something.']);
});

test('a passing check that counted fewer fragments than are pending fails the guard', () => {
  expect(fragmentCheckProblems({ checked: 0, kind: 'passed', warnings: [] }, 1, [])).toEqual([
    'loom changelog check checked 0 fragments, but 1 is pending in .changes/; check packages/collector/loom.config.json.',
  ]);
});

test('a failed check reports both Loom lines and plain-text problems', () => {
  expect(
    fragmentCheckProblems({ kind: 'failed', lines: ['.changes/a.md: bad.'] }, 1, [
      '.changes/b.md: line 1: control character.',
    ]),
  ).toEqual(['.changes/a.md: bad.', '.changes/b.md: line 1: control character.']);
});

test('a check that could not run says so, beside plain-text problems', () => {
  expect(
    fragmentCheckProblems({ kind: 'unrunnable', reason: 'Script not found "loom"' }, 1, [
      '.changes/b.md: not valid UTF-8.',
    ]),
  ).toEqual([
    'Could not run loom changelog check: Script not found "loom"',
    '.changes/b.md: not valid UTF-8.',
  ]);
});

test('a hidden file in .changes/ is not a pending fragment, as Loom skips it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'heimdall-fragments-'));
  try {
    await mkdir(join(root, '.changes'));
    await writeFile(join(root, '.changes', 'README.md'), '# Guide\n');
    await writeFile(join(root, '.changes', '.draft.md'), '- **Draft.**\n');
    await writeFile(join(root, '.changes', 'feature.x.md'), '- **X.**\n');

    expect(await pendingFragments(root)).toEqual(['.changes/feature.x.md']);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('a check that failed without printing a report still fails the guard', () => {
  expect(fragmentCheckProblems({ kind: 'failed', lines: [] }, 1, [])).toEqual([
    'loom changelog check failed without printing a report.',
  ]);
});

test('a fragment that is a symbolic link is refused without being read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'heimdall-fragments-'));
  try {
    await mkdir(join(root, '.changes'));
    await symlink('/dev/zero', join(root, '.changes', 'feature.x.md'));

    expect(await plainTextProblems(root, ['.changes/feature.x.md'])).toEqual([
      '.changes/feature.x.md: not a regular file; fragments are regular files',
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
