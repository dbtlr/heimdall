import { expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { tempStateDir } from '../testing/fixtures.ts';
import {
  createUpdatesSource,
  parseUpdatesConfig,
  readUpdatesConfig,
  startUpdates,
} from './source.ts';

test('a missing configured Homebrew executable reports unavailable coverage with its original identity', async () => {
  await using dir = await tempStateDir();
  const prefix = join(dir.path, 'brew');
  const source = createUpdatesSource({
    config: parseUpdatesConfig({ homebrewPrefixes: [prefix] }),
    now: () => 1000,
    platform: 'darwin',
  });
  await source.tick();
  expect(source.latest()?.managers.find(({ manager }) => manager === 'homebrew')).toMatchObject({
    installation: prefix,
    observedAt: 1000,
    result: { kind: 'unavailable' },
  });
});

test('APT preserves complete installed census when metadata is missing and supports Debian reboot marker', async () => {
  await using dir = await tempStateDir();
  const osRelease = join(dir.path, 'os-release');
  await writeFile(osRelease, 'ID=ubuntu\nID_LIKE=debian\n');
  const config = parseUpdatesConfig({
    aptListsDir: join(dir.path, 'lists'),
    homebrewPrefixes: [],
    osRelease,
    rebootMarker: join(dir.path, 'reboot'),
  });
  const source = createUpdatesSource({
    command: async () => ({
      exitCode: 0,
      kind: 'exited',
      stderr: '',
      stdout: 'installed\tlibfoo\tamd64\t1.0\n',
    }),
    config,
    now: () => 1000,
    platform: 'linux',
  });
  await source.tick();
  expect(source.latest()).toMatchObject({
    managers: [
      { installed: { names: ['libfoo:amd64'], observedAt: 1000 }, result: { kind: 'unavailable' } },
    ],
    reboot: { kind: 'available', required: false },
  });
});

test('APT reports architecture-stable identities and explicit security from local metadata', async () => {
  await using dir = await tempStateDir();
  const osRelease = join(dir.path, 'os-release');
  const lists = join(dir.path, 'lists');
  await writeFile(osRelease, 'ID=debian\n');
  await mkdir(lists);
  await writeFile(join(lists, 'repo_Packages.lz4'), 'local index');
  const source = createUpdatesSource({
    command: async (cmd) => ({
      exitCode: 0,
      kind: 'exited',
      stderr: '',
      stdout:
        cmd[0] === '/usr/bin/dpkg-query'
          ? 'installed\tlibfoo\tamd64\t1.0\n'
          : 'Listing...\nlibfoo/stable-security 2.0 amd64 [upgradable from: 1.0]\n',
    }),
    config: parseUpdatesConfig({
      aptListsDir: lists,
      homebrewPrefixes: [],
      osRelease,
      rebootMarker: join(dir.path, 'reboot'),
    }),
    now: Date.now,
    platform: 'linux',
  });
  await source.tick();
  expect(source.latest()?.managers[0]).toMatchObject({
    installed: { names: ['libfoo:amd64'] },
    result: {
      kind: 'available',
      metadataAt: expect.any(Number),
      updates: [{ available: '2.0', installed: '1.0', name: 'libfoo:amd64', security: true }],
    },
  });
});

test('an invalid census is never complete evidence, and unsupported OS never claims no reboot', async () => {
  await using dir = await tempStateDir();
  const osRelease = join(dir.path, 'os-release');
  await writeFile(osRelease, 'ID=fedora\n');
  let commands = 0;
  const source = createUpdatesSource({
    command: async () => {
      commands++;
      throw new Error('must not run');
    },
    config: parseUpdatesConfig({ homebrewPrefixes: [], osRelease }),
    now: () => 1000,
    platform: 'linux',
  });
  await source.tick();
  expect(commands).toBe(0);
  expect(source.latest()?.reboot.kind).toBe('unavailable');
  await writeFile(osRelease, 'ID=debian\n');
  const malformed = createUpdatesSource({
    command: async () => ({ exitCode: 0, kind: 'exited', stderr: '', stdout: 'garbage' }),
    config: parseUpdatesConfig({ aptListsDir: dir.path, homebrewPrefixes: [], osRelease }),
    now: () => 1000,
    platform: 'linux',
  });
  await malformed.tick();
  expect(malformed.latest()?.managers[0]?.installed).toBeUndefined();
});

test('oversized source observations become unavailable without a partial installed census', async () => {
  await using dir = await tempStateDir();
  const osRelease = join(dir.path, 'os-release');
  await writeFile(osRelease, 'ID=debian\n');
  const names = Array.from(
    { length: 19000 },
    (_, i) => `installed\tpackage${i}${'x'.repeat(80)}\tamd64\t1\n`,
  ).join('');
  const source = createUpdatesSource({
    command: async () => ({ exitCode: 0, kind: 'exited', stderr: '', stdout: names }),
    config: parseUpdatesConfig({ aptListsDir: dir.path, homebrewPrefixes: [], osRelease }),
    now: () => 1000,
    platform: 'linux',
  });
  await source.tick();
  expect(source.latest()?.managers[0]).toMatchObject({ result: { kind: 'unavailable' } });
  expect(source.latest()?.managers[0]?.installed).toBeUndefined();
});

test('Homebrew reads signed local metadata for its owning account without running brew', async () => {
  const { constants, generateKeyPairSync, sign } = await import('node:crypto');
  await using dir = await tempStateDir();
  const prefix = join(dir.path, 'brew');
  const cache = join(dir.path, 'cache');
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await mkdir(join(prefix, 'Library/Homebrew/api'), { recursive: true });
  await mkdir(join(prefix, 'Cellar/foo/1.0'), { recursive: true });
  await writeFile(join(prefix, 'bin/brew'), '#!/bin/false');
  await writeFile(
    join(prefix, 'Cellar/foo/1.0/INSTALL_RECEIPT.json'),
    JSON.stringify({ source: { tap: 'homebrew/core' } }),
  );
  await mkdir(cache);
  // oxlint-disable-next-line node/no-sync -- Small ephemeral test key avoids external fixture dependencies.
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await writeFile(
    join(prefix, 'Library/Homebrew/api/homebrew-1.pem'),
    keys.publicKey.export({ format: 'pem', type: 'spki' }),
  );
  const payload = JSON.stringify([
    {
      name: 'foo',
      revision: 0,
      tap: 'homebrew/core',
      version_scheme: 0,
      versions: { stable: '2.0' },
    },
  ]);
  const protectedHeader = Buffer.from(JSON.stringify({ alg: 'PS512', b64: false })).toString(
    'base64url',
  );
  const signature = sign('sha512', Buffer.from(`${protectedHeader}.${payload}`), {
    key: keys.privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 64,
  }).toString('base64url');
  await writeFile(
    join(cache, 'formula.jws.json'),
    JSON.stringify({
      payload,
      signatures: [{ header: { kid: 'homebrew-1' }, protected: protectedHeader, signature }],
    }),
  );
  const source = createUpdatesSource({
    command: async () => {
      throw new Error('must never run brew');
    },
    config: parseUpdatesConfig({ homebrewCacheDir: cache, homebrewPrefixes: [prefix] }),
    now: Date.now,
    platform: 'darwin',
  });
  await source.tick();
  expect(source.latest()?.managers[0]).toMatchObject({
    installed: { names: ['formula:foo'] },
    manager: 'homebrew',
    result: {
      kind: 'available',
      updates: [{ available: '2.0', installed: '1.0', name: 'formula:foo', security: null }],
    },
  });
  await mkdir(join(prefix, 'Caskroom/bar/1.0'), { recursive: true });
  const caskReceipt = join(prefix, 'Caskroom/bar/.metadata/1.0/20260101000000/Casks');
  await mkdir(caskReceipt, { recursive: true });
  await writeFile(
    join(caskReceipt, 'bar.json'),
    JSON.stringify({ tap: 'homebrew/cask', token: 'bar', version: '1.0' }),
  );
  const caskPayload = JSON.stringify([{ token: 'bar', version: '2.0' }]);
  const caskSignature = sign('sha512', Buffer.from(`${protectedHeader}.${caskPayload}`), {
    key: keys.privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 64,
  }).toString('base64url');
  await writeFile(
    join(cache, 'cask.jws.json'),
    JSON.stringify({
      payload: caskPayload,
      signatures: [
        { header: { kid: 'homebrew-1' }, protected: protectedHeader, signature: caskSignature },
      ],
    }),
  );
  await source.tick();
  expect(source.latest()?.managers[0]).toMatchObject({
    installed: { names: ['formula:foo', 'cask:bar'] },
    result: {
      kind: 'available',
      updates: [{ name: 'formula:foo' }, { available: '2.0', name: 'cask:bar' }],
    },
  });
  await writeFile(
    join(cache, 'cask.jws.json'),
    JSON.stringify({
      payload: '[]',
      signatures: [
        { header: { kid: 'homebrew-1' }, protected: protectedHeader, signature: caskSignature },
      ],
    }),
  );
  await source.tick();
  expect(source.latest()?.managers[0]).toMatchObject({
    installed: {
      names: ['formula:foo', 'cask:bar'],
      versions: [
        { name: 'formula:foo', version: '1.0' },
        { name: 'cask:bar', version: '1.0' },
      ],
    },
    result: { kind: 'unavailable' },
  });
});

test('update configuration follows the selected collector.toml and rejects unusable settings', async () => {
  await using dir = await tempStateDir();
  await writeFile(
    join(dir.path, 'collector.toml'),
    '[updates]\nintervalHours = 12\naptListsDir = "/mock/apt/lists"\n',
  );
  expect(
    await readUpdatesConfig({ cwd: dir.path, home: undefined, named: 'collector.toml' }),
  ).toMatchObject({ aptListsDir: '/mock/apt/lists', intervalHours: 12 });
  expect(parseUpdatesConfig(undefined).intervalHours).toBe(6);
  expect(() => parseUpdatesConfig({ intervalHours: 0 })).toThrow();
  expect(() => parseUpdatesConfig({ apt: 'apt' })).toThrow();
  expect(() => parseUpdatesConfig({ apt: `/${'é'.repeat(260)}` })).toThrow();
  expect(() => parseUpdatesConfig({ toString: 'unknown' })).toThrow();
});

test('stopping the update loop cancels the active command and publishes no cancelled evidence', async () => {
  await using dir = await tempStateDir();
  const osRelease = join(dir.path, 'os-release');
  await writeFile(osRelease, 'ID=debian\n');
  const entered = Promise.withResolvers<void>();
  const source = startUpdates({
    command: async (_, options) => {
      entered.resolve();
      const cancelled = Promise.withResolvers<void>();
      options?.signal?.addEventListener('abort', () => cancelled.resolve(), { once: true });
      await cancelled.promise;
      return { kind: 'cancelled' };
    },
    config: parseUpdatesConfig({ aptListsDir: dir.path, homebrewPrefixes: [], osRelease }),
    log: { info: () => 0, warn: () => 0 },
    now: Date.now,
    platform: 'linux',
  });
  await entered.promise;
  await source.stop();
  expect(source.latest()).toBeUndefined();
});

test('a failed APT check never proves partially installed packages were removed', async () => {
  await using dir = await tempStateDir();
  const osRelease = join(dir.path, 'os-release');
  await writeFile(osRelease, 'ID=debian\n');
  await writeFile(join(dir.path, 'repo_Packages'), 'local index');
  let failed = false;
  let unknownStatus = false;
  const source = createUpdatesSource({
    command: async (cmd) => {
      if (cmd[0] === '/usr/bin/dpkg-query') {
        return {
          exitCode: 0,
          kind: 'exited',
          stderr: '',
          stdout: `${unknownStatus ? 'unrecognized' : 'half-configured'}\topenssl\tamd64\t3.0.1-1\ninstalled\tbash\tamd64\t5.0\nunpacked\tfoo\tamd64\t1\nhalf-installed\tbar\tamd64\t1\ntriggers-awaited\tbaz\tamd64\t1\ntriggers-pending\tqux\tamd64\t1\nconfig-files\tremoved\tamd64\t1\nnot-installed\tabsent\tamd64\t1\n`,
        };
      }
      return failed
        ? { kind: 'timed out' }
        : {
            exitCode: 0,
            kind: 'exited',
            stderr: '',
            stdout:
              'Listing...\nopenssl/stable-security 3.0.2-1 amd64 [upgradable from: 3.0.1-1]\n',
          };
    },
    config: parseUpdatesConfig({ aptListsDir: dir.path, homebrewPrefixes: [], osRelease }),
    now: Date.now,
    platform: 'linux',
  });
  await source.tick();
  expect(source.latest()?.managers[0]?.result.kind).toBe('available');
  expect(source.latest()?.managers[0]?.installed?.versions).toEqual([
    { name: 'bash:amd64', version: '5.0' },
  ]);
  failed = true;
  await source.tick();
  expect(source.latest()?.managers[0]).toMatchObject({
    installed: {
      names: ['openssl:amd64', 'bash:amd64', 'foo:amd64', 'bar:amd64', 'baz:amd64', 'qux:amd64'],
    },
    result: { kind: 'unavailable' },
  });
  expect(source.latest()?.managers[0]?.installed?.versions).toEqual([
    { name: 'bash:amd64', version: '5.0' },
  ]);
  unknownStatus = true;
  await source.tick();
  expect(source.latest()?.managers[0]?.installed).toBeUndefined();
});

test('Homebrew confirms newest installed versions independently of repository cache', async () => {
  await using dir = await tempStateDir();
  const prefix = join(dir.path, 'brew');
  await mkdir(join(prefix, 'bin'), { recursive: true });
  await writeFile(join(prefix, 'bin/brew'), '#!/bin/false');
  await mkdir(join(prefix, 'Library/Homebrew/api'), { recursive: true });
  await writeFile(
    join(prefix, 'Library/Homebrew/api/homebrew-1.pem'),
    'unused when cache is missing',
  );
  for (const version of ['1.0', '2.0']) {
    // oxlint-disable-next-line no-await-in-loop -- Construct the two installed keg fixtures in order.
    await mkdir(join(prefix, 'Cellar/foo', version), { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- Each fixture receipt proves local installation independently of cache.
    await writeFile(
      join(prefix, 'Cellar/foo', version, 'INSTALL_RECEIPT.json'),
      JSON.stringify({ source: { tap: 'homebrew/core' } }),
    );
  }
  await mkdir(join(prefix, 'Cellar/uncertain/HEAD-abc'), { recursive: true });
  await writeFile(
    join(prefix, 'Cellar/uncertain/HEAD-abc/INSTALL_RECEIPT.json'),
    JSON.stringify({ source: { tap: 'homebrew/core' } }),
  );
  await mkdir(join(prefix, 'Caskroom/bar/2.0'), { recursive: true });
  const caskReceipt = join(prefix, 'Caskroom/bar/.metadata/2.0/20260101000000/Casks');
  await mkdir(caskReceipt, { recursive: true });
  await writeFile(
    join(caskReceipt, 'bar.json'),
    JSON.stringify({ tap: 'homebrew/cask', token: 'bar', version: '2.0' }),
  );
  const source = createUpdatesSource({
    config: parseUpdatesConfig({
      homebrewCacheDir: join(dir.path, 'missing-cache'),
      homebrewPrefixes: [prefix],
    }),
    now: Date.now,
    platform: 'darwin',
  });
  await source.tick();
  expect(source.latest()?.managers[0]).toMatchObject({
    installed: {
      versions: [
        { name: 'formula:foo', version: '2.0' },
        { name: 'cask:bar', version: '2.0' },
      ],
    },
    result: { kind: 'unavailable' },
  });
  expect(source.latest()?.managers[0]?.installed?.names.toSorted()).toEqual([
    'cask:bar',
    'formula:foo',
    'formula:uncertain',
  ]);
  await writeFile(join(prefix, 'Cellar/foo/2.0/INSTALL_RECEIPT.json'), '{corrupt');
  await source.tick();
  expect(source.latest()?.managers[0]?.installed).toBeUndefined();
});
