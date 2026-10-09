import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import { readSessionsSection } from './config-file.ts';

const TOML_PATH = '.config/heimdall/collector.toml';
const JSON_PATH = '.config/heimdall/collector.json';

const put = async (root: string, relative: string, content: string) => {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
};

const tomlWith = (name: string) => `[[sessions.sources]]\nharness = "${name}"\n`;

const sourcesOf = (harness: string) => ({ sources: [{ harness }] });

test('the working directory beats the home directory', async () => {
  await using cwd = await tempStateDir();
  await using home = await tempStateDir();
  await put(cwd.path, TOML_PATH, tomlWith('codex'));
  await put(home.path, TOML_PATH, tomlWith('claude-code'));
  expect(await readSessionsSection({ cwd: cwd.path, home: home.path, named: undefined })).toEqual(
    sourcesOf('codex'),
  );
});

test('the home directory answers when the working directory holds no file', async () => {
  await using cwd = await tempStateDir();
  await using home = await tempStateDir();
  await put(home.path, TOML_PATH, tomlWith('claude-code'));
  expect(await readSessionsSection({ cwd: cwd.path, home: home.path, named: undefined })).toEqual(
    sourcesOf('claude-code'),
  );
});

test('the home directory answers when the working directory is also the home directory', async () => {
  await using home = await tempStateDir();
  await put(home.path, TOML_PATH, tomlWith('codex'));
  expect(await readSessionsSection({ cwd: home.path, home: home.path, named: undefined })).toEqual(
    sourcesOf('codex'),
  );
});

test('toml is tried before json in the same directory', async () => {
  await using cwd = await tempStateDir();
  await put(cwd.path, TOML_PATH, tomlWith('codex'));
  await put(cwd.path, JSON_PATH, JSON.stringify({ sessions: sourcesOf('claude-code') }));
  expect(await readSessionsSection({ cwd: cwd.path, home: cwd.path, named: undefined })).toEqual(
    sourcesOf('codex'),
  );
});

test('a json file is read as JSON', async () => {
  await using cwd = await tempStateDir();
  await put(cwd.path, JSON_PATH, JSON.stringify({ sessions: sourcesOf('claude-code') }));
  expect(await readSessionsSection({ cwd: cwd.path, home: cwd.path, named: undefined })).toEqual(
    sourcesOf('claude-code'),
  );
});

test('a TOML file with an integer past 2^53 elsewhere still yields its sources, as Loom reads it', async () => {
  await using cwd = await tempStateDir();
  await put(cwd.path, TOML_PATH, `stamp = 9007199254740993\n${tomlWith('codex')}`);
  expect(await readSessionsSection({ cwd: cwd.path, home: cwd.path, named: undefined })).toEqual(
    sourcesOf('codex'),
  );
});

test('the named file is the only file, resolved against the working directory', async () => {
  await using cwd = await tempStateDir();
  await using home = await tempStateDir();
  await put(cwd.path, TOML_PATH, tomlWith('claude-code'));
  await put(cwd.path, 'other.toml', tomlWith('codex'));
  expect(
    await readSessionsSection({ cwd: cwd.path, home: home.path, named: 'other.toml' }),
  ).toEqual(sourcesOf('codex'));
});

test('a named file that is missing does not fall back to a discovered file', async () => {
  await using cwd = await tempStateDir();
  await put(cwd.path, TOML_PATH, tomlWith('claude-code'));
  expect(
    await readSessionsSection({ cwd: cwd.path, home: cwd.path, named: 'missing.toml' }),
  ).toBeUndefined();
});

test('an unparseable discovered file counts as absent and the home directory answers', async () => {
  await using cwd = await tempStateDir();
  await using home = await tempStateDir();
  await put(cwd.path, TOML_PATH, 'this is = not [ toml');
  await put(home.path, TOML_PATH, tomlWith('codex'));
  expect(await readSessionsSection({ cwd: cwd.path, home: home.path, named: undefined })).toEqual(
    sourcesOf('codex'),
  );
});

test('an unparseable file yields no section', async () => {
  await using cwd = await tempStateDir();
  await put(cwd.path, JSON_PATH, '{ nope');
  expect(
    await readSessionsSection({ cwd: cwd.path, home: cwd.path, named: undefined }),
  ).toBeUndefined();
});

test('a file with no sessions key yields no section', async () => {
  await using cwd = await tempStateDir();
  await put(cwd.path, TOML_PATH, 'hub = "https://hub.example"\n');
  expect(
    await readSessionsSection({ cwd: cwd.path, home: cwd.path, named: undefined }),
  ).toBeUndefined();
});

test('no file anywhere yields no section', async () => {
  await using cwd = await tempStateDir();
  await using home = await tempStateDir();
  expect(
    await readSessionsSection({ cwd: cwd.path, home: home.path, named: undefined }),
  ).toBeUndefined();
});

test('a JSON file that holds an array rather than an object yields no section', async () => {
  await using cwd = await tempStateDir();
  await put(cwd.path, JSON_PATH, '[{"sessions": 1}]');
  expect(
    await readSessionsSection({ cwd: cwd.path, home: cwd.path, named: undefined }),
  ).toBeUndefined();
});
