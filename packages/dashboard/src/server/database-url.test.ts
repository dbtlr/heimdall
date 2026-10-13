import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { databaseUrl } from './database-url.ts';

const URL_IN_FILE = 'postgres://hub@db.test:5432/heimdall';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'heimdall-dashboard-'));
});

afterEach(async () => {
  await rm(home, { force: true, recursive: true });
});

// Writes a Hub config file at `dir/heimdall/hub.toml`.
const writeHubConfig = async (dir: string, body: string) => {
  await mkdir(join(dir, 'heimdall'), { recursive: true });
  await writeFile(join(dir, 'heimdall', 'hub.toml'), body);
};

// The message of the error `promise` fails with, or undefined if it succeeds.
const failureOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
};

const fileWith = (url: string) => `host = "127.0.0.1"\n\n[database]\nurl = "${url}"\n`;

test('HEIMDALL_DATABASE_URL wins over the config file', async () => {
  await writeHubConfig(join(home, '.config'), fileWith(URL_IN_FILE));

  const url = await databaseUrl({ HEIMDALL_DATABASE_URL: 'postgres://env.test/db', HOME: home });

  expect(url).toBe('postgres://env.test/db');
});

test('reads [database] url from $HOME/.config/heimdall/hub.toml', async () => {
  await writeHubConfig(join(home, '.config'), fileWith(URL_IN_FILE));

  expect(await databaseUrl({ HOME: home })).toBe(URL_IN_FILE);
});

test('reads $HOME/.config as the Hub does, whatever XDG_CONFIG_HOME says', async () => {
  await writeHubConfig(join(home, '.config'), fileWith(URL_IN_FILE));
  await writeHubConfig(join(home, 'xdg'), fileWith('postgres://xdg.test/db'));

  expect(await databaseUrl({ HOME: home, XDG_CONFIG_HOME: join(home, 'xdg') })).toBe(URL_IN_FILE);
});

test('an empty HEIMDALL_DATABASE_URL counts as unset', async () => {
  await writeHubConfig(join(home, '.config'), fileWith(URL_IN_FILE));

  expect(await databaseUrl({ HEIMDALL_DATABASE_URL: '', HOME: home })).toBe(URL_IN_FILE);
});

test('names the file it looked for when there is none', async () => {
  expect(await failureOf(databaseUrl({ HOME: home }))).toContain(
    join(home, '.config', 'heimdall', 'hub.toml'),
  );
});

test('says so when the config file has no [database] url', async () => {
  await writeHubConfig(join(home, '.config'), 'host = "127.0.0.1"\n');

  expect(await failureOf(databaseUrl({ HOME: home }))).toContain('[database] url');
});
