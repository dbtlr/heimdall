import { expect, test } from 'bun:test';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { findSharedDirectory, HARNESSES, parseSources } from './sources.ts';
import type { Source } from './sources.ts';

const HOME = '/home/operator';

const sourcesOf = (section: unknown) => {
  const parsed = parseSources(section, HOME);
  if (parsed.kind === 'refused') {
    throw new Error(parsed.problem);
  }
  return parsed.sources;
};

const problemOf = (section: unknown) => {
  const parsed = parseSources(section, HOME);
  if (parsed.kind === 'sources') {
    throw new Error('expected the section to be refused');
  }
  return parsed.problem;
};

test('each Harness has a default directory and the trees it keeps transcripts in', () => {
  expect(HARNESSES['claude-code']).toEqual({ defaultDir: '.claude', trees: ['projects'] });
  expect(HARNESSES.codex).toEqual({ defaultDir: '.codex', trees: ['sessions'] });
});

test('no section, no sources key, and an empty list all leave capture off', () => {
  expect(sourcesOf(undefined)).toEqual([]);
  expect(sourcesOf({})).toEqual([]);
  expect(sourcesOf({ sources: [] })).toEqual([]);
});

test('a source defaults its name to the Harness and its directory to the Harness default', () => {
  expect(sourcesOf({ sources: [{ harness: 'claude-code' }, { harness: 'codex' }] })).toEqual([
    {
      dir: '/home/operator/.claude',
      harness: 'claude-code',
      name: 'claude-code',
      trees: ['projects'],
    },
    { dir: '/home/operator/.codex', harness: 'codex', name: 'codex', trees: ['sessions'] },
  ]);
});

test('a source keeps the name it is given', () => {
  const [source] = sourcesOf({ sources: [{ harness: 'codex', name: 'codex-work' }] });
  expect(source?.name).toBe('codex-work');
});

test('a directory of ~ or ~/ is expanded against the home directory', () => {
  const sources = sourcesOf({
    sources: [
      { dir: '~/work/.claude', harness: 'claude-code', name: 'a' },
      { dir: '~', harness: 'codex', name: 'b' },
    ],
  });
  expect(sources.map((source) => source.dir)).toEqual([
    '/home/operator/work/.claude',
    '/home/operator',
  ]);
});

test('an absolute directory is kept and loses trailing slashes', () => {
  const [source] = sourcesOf({ sources: [{ dir: '/srv/agents/.codex//', harness: 'codex' }] });
  expect(source?.dir).toBe('/srv/agents/.codex');
});

test('a relative directory is refused', () => {
  expect(problemOf({ sources: [{ dir: 'agents/.codex', harness: 'codex' }] })).toContain(
    '"agents/.codex"',
  );
  expect(problemOf({ sources: [{ dir: '~other/.codex', harness: 'codex' }] })).toContain(
    '"~other/.codex"',
  );
});

test('an unknown Harness is refused by name', () => {
  expect(problemOf({ sources: [{ harness: 'cursor' }] })).toContain('"cursor"');
});

test('a name that is not a DNS label is refused', () => {
  expect(problemOf({ sources: [{ harness: 'codex', name: 'Codex Work' }] })).toContain(
    '"Codex Work"',
  );
});

test('two sources sharing a name are refused', () => {
  expect(
    problemOf({
      sources: [
        { dir: '/a', harness: 'claude-code' },
        { dir: '/b', harness: 'claude-code' },
      ],
    }),
  ).toBe('two sessions.sources share the name "claude-code"; give one a distinct name.');
});

test('two sources resolving to the same directory are refused', () => {
  expect(
    problemOf({
      sources: [
        { harness: 'claude-code' },
        { dir: '~/.claude/', harness: 'claude-code', name: 'again' },
      ],
    }),
  ).toBe('two sessions.sources read the directory "/home/operator/.claude"; list it once.');
});

test('a key a source does not define is refused', () => {
  expect(problemOf({ sources: [{ harness: 'codex', path: '/x' }] })).toContain('path');
});

test('a source without a Harness is refused', () => {
  expect(problemOf({ sources: [{ dir: '/x' }] })).toContain('harness');
});

test('a section that is not an object, or whose sources is not a list, is refused', () => {
  expect(problemOf('codex')).toContain('sessions');
  expect(problemOf({ sources: 'codex' })).toContain('sessions.sources');
  expect(problemOf({ sources: ['codex'] })).toContain('sessions.sources');
});

test('a key beside sources is refused', () => {
  expect(problemOf({ sorces: [], sources: [] })).toContain('sorces');
});

const many = (count: number) => ({
  sources: Array.from({ length: count }, (_, index) => ({
    dir: `/srv/${String(index)}`,
    harness: 'codex',
    name: `s${String(index)}`,
  })),
});

test('at most 64 sources are accepted', () => {
  expect(sourcesOf(many(64))).toHaveLength(64);
  expect(problemOf(many(65))).toContain('64');
});

const at = (dir: string, name: string): Source => ({
  dir,
  harness: 'claude-code',
  name,
  trees: ['projects'],
});

test('two sources whose directories are one through a symbolic link share it', async () => {
  await using root = await tempStateDir();
  await mkdir(join(root.path, 'claude'));
  await symlink(join(root.path, 'claude'), join(root.path, 'alias'));

  expect(
    await findSharedDirectory([
      at(join(root.path, 'claude'), 'claude-code'),
      at(join(root.path, 'alias'), 'work'),
    ]),
  ).toContain('"claude-code" and "work" read one directory');
});

test('distinct and absent directories share nothing', async () => {
  await using root = await tempStateDir();
  await mkdir(join(root.path, 'a'));
  await mkdir(join(root.path, 'b'));

  expect(
    await findSharedDirectory([
      at(join(root.path, 'a'), 'a'),
      at(join(root.path, 'b'), 'b'),
      at(join(root.path, 'gone-1'), 'c'),
      at(join(root.path, 'gone-2'), 'd'),
    ]),
  ).toBeUndefined();
});
