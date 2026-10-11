import { expect, test } from 'bun:test';

import type { InstallReader } from './harness-installs.ts';
import { createHarnessScan, startHarnessScan } from './harness-scan.ts';

const MISE = '/home/operator/.local/share/mise/installs';

// A reader whose mise installs are the versions in `held`, which a test changes.
const readerOf = (held: { versions: string[]; failing?: boolean }): InstallReader => ({
  readDir: (path) => {
    if (held.failing) {
      return Promise.reject(new Error('EIO'));
    }
    return Promise.resolve(
      path === `${MISE}/claude`
        ? held.versions.map((name) => ({ isDirectory: true, isSymlink: false, name }))
        : undefined,
    );
  },
  readText: () => Promise.resolve(undefined),
});

const scanOf = (held: { versions: string[]; failing?: boolean }) =>
  createHarnessScan({ env: {}, home: '/home/operator', platform: 'linux', reader: readerOf(held) });

test('has no section until the first scan finishes', () => {
  expect(scanOf({ versions: ['2.1.296'] }).latest()).toBeUndefined();
});

test('answers the installs the last scan found', async () => {
  const held = { versions: ['2.1.296'] };
  const scan = scanOf(held);

  await scan.tick();

  expect(scan.latest()).toEqual({
    installs: [{ harness: 'claude-code', location: 'mise', version: '2.1.296' }],
  });
});

test('a System with no Harness has a section that lists nothing, not none', async () => {
  const scan = scanOf({ versions: [] });

  await scan.tick();

  expect(scan.latest()).toEqual({ installs: [] });
});

test('answers the same object until the installs change', async () => {
  const held = { versions: ['2.1.296'] };
  const scan = scanOf(held);
  await scan.tick();
  const first = scan.latest();

  await scan.tick();
  const unchanged = scan.latest();
  held.versions = ['2.1.296', '2.2.0'];
  await scan.tick();

  expect(unchanged).toBe(first);
  expect(scan.latest()?.installs.map((i) => i.version)).toEqual(['2.1.296', '2.2.0']);
});

test('a System whose directories cannot be read reports their installs as unknown rather than failing', async () => {
  const scan = scanOf({ failing: true, versions: ['2.1.296'] });

  await scan.tick();

  const installs = scan.latest()?.installs ?? [];
  expect(installs.length).toBeGreaterThan(0);
  expect(installs.every((i) => i.version === 'unknown')).toBe(true);
});

// A reader whose directory reads stay pending until `release` is called.
const gatedReader = () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const reader: InstallReader = {
    readDir: async () => {
      await gate;
      return undefined;
    },
    readText: () => Promise.resolve(undefined),
  };
  return { reader, release };
};

const started = (reader: InstallReader, stopWaitMs?: number) =>
  startHarnessScan({
    env: {},
    home: '/home/operator',
    log: { info: () => 0, warn: () => 0 },
    platform: 'linux',
    reader,
    ...(stopWaitMs === undefined ? {} : { stopWaitMs }),
  });

test('stopping waits for a scan in flight', async () => {
  const { reader, release } = gatedReader();
  const scan = started(reader);
  let stopped = false;

  const stopping = (async () => {
    await scan.stop();
    stopped = true;
  })();
  await Bun.sleep(20);
  const waitedForScan = !stopped;
  release();
  await stopping;

  expect(waitedForScan).toBe(true);
  expect(scan.latest()).toEqual({ installs: [] });
});

test('a scan that never finishes cannot hold stopping forever', async () => {
  const { reader } = gatedReader();
  const scan = started(reader, 30);
  const stopping = (async () => {
    await scan.stop();
    return 'stopped';
  })();

  const outcome = await Promise.race([stopping, Bun.sleep(2000)]);

  expect(outcome).toBe('stopped');
});
