import { expect, test } from 'bun:test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { setPort, withPort } from './settings.ts';
import { tempHome } from './testing.ts';

test('a file with no port gains one', () => {
  expect(withPort('database = "postgres://localhost/heimdall"\n', 9090)).toBe(
    'database = "postgres://localhost/heimdall"\nport = 9090\n',
  );
});

test('an empty file gains the port alone', () => {
  expect(withPort('', 9090)).toBe('port = 9090\n');
});

test('a top-level port with another value is replaced in place', () => {
  expect(withPort('# The Hub\nport = 8080 # Fleet\nhost = "127.0.0.1"\n', 9090)).toBe(
    '# The Hub\nport = 9090\nhost = "127.0.0.1"\n',
  );
});

test('the port goes in as a top-level key, before the first table', () => {
  const before = [
    'database = "postgres://localhost/heimdall"',
    'tokens = [',
    '  "laptop-1=a",',
    ']',
    '',
    '[later]',
    'port = 1',
    '',
  ].join('\n');

  const after = withPort(before, 9090);

  expect(after).toBe(
    [
      'database = "postgres://localhost/heimdall"',
      'tokens = [',
      '  "laptop-1=a",',
      ']',
      'port = 9090',
      '',
      '[later]',
      'port = 1',
      '',
    ].join('\n'),
  );
  expect(Bun.TOML.parse(after ?? '')).toEqual({
    database: 'postgres://localhost/heimdall',
    later: { port: 1 },
    port: 9090,
    tokens: ['laptop-1=a'],
  });
});

test('a file that starts with a table gains the port above it', () => {
  expect(withPort('[later]\nkey = 1\n', 9090)).toBe('port = 9090\n\n[later]\nkey = 1\n');
});

test('a file that already holds the port needs no change', () => {
  expect(withPort('port = 9090\n', 9090)).toBeUndefined();
  expect(withPort('port = "9090"\n', 9090)).toBeUndefined();
});

test('a file that is not TOML is refused rather than edited', () => {
  expect(() => withPort('port = = 1\n', 9090)).toThrow('not valid TOML');
});

test('setPort creates the file and its directories when they are missing', async () => {
  await using home = await tempHome();
  const file = join(home.path, '.config', 'heimdall', 'hub.toml');

  expect(await setPort(file, 9090)).toBe(true);

  expect(await readFile(file, 'utf8')).toBe('port = 9090\n');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test('setPort leaves a file that already holds the value untouched, byte for byte', async () => {
  await using home = await tempHome();
  const file = join(home.path, 'hub.toml');
  // Odd spacing and a comment that a rewrite would not reproduce.
  const rendered = 'database = "postgres://db/heimdall"\nport   =   9090   # rendered by Fleet\n';
  await writeFile(file, rendered);
  const before = await stat(file);

  expect(await setPort(file, 9090)).toBe(false);

  expect(await readFile(file, 'utf8')).toBe(rendered);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
});

test('setPort rewrites a file whose port differs', async () => {
  await using home = await tempHome();
  await mkdir(join(home.path, 'sub'));
  const file = join(home.path, 'sub', 'hub.toml');
  await writeFile(file, 'port = 8080\n');

  expect(await setPort(file, 9090)).toBe(true);

  expect(await readFile(file, 'utf8')).toBe('port = 9090\n');
});

test('setPort refuses to create hub.toml beside a hub.json, which it would shadow', async () => {
  await using home = await tempHome();
  const json = join(home.path, 'hub.json');
  await writeFile(json, '{"database":"postgres://db/heimdall"}');

  const error = await setPort(join(home.path, 'hub.toml'), 9090).then(
    () => undefined,
    (failure: unknown) => failure,
  );

  expect(String(error)).toContain('hub.json holds the settings');
  expect(await Bun.file(join(home.path, 'hub.toml')).exists()).toBe(false);
  expect(await readFile(json, 'utf8')).toBe('{"database":"postgres://db/heimdall"}');
});
