import { expect, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { FilesRecord } from '@heimdall/schema';

import { openRecords } from '../records.ts';
import type { RecordStore } from '../records.ts';
import { tempStateDir } from '../testing/fixtures.ts';
import { createChecks, RECHECK_MS } from './loop.ts';

const sha = (content: string) => new Bun.CryptoHasher('sha256').update(content).digest('hex');

const START = Date.parse('2026-10-10T08:00:00Z');

// A files record for `files`, each recorded with the hash of `content`.
const record = (name: string, files: Record<string, string>): FilesRecord => ({
  files: Object.entries(files).map(([path, content]) => ({ path, sha256: sha(content) })),
  name,
});

// A Collector's records in a fresh state directory and files in another, with
// the checks over them on a clock the test sets. `elsewhere` changes the
// records through a connection of its own, as `record` and `forget` do.
const setup = async (dir: { path: string }, open?: () => Promise<RecordStore>) => {
  const warnings: string[] = [];
  let now = START;
  const checks = createChecks({
    log: { info: () => 0, warn: (m) => warnings.push(m) },
    now: () => now,
    open: open ?? (() => openRecords({ stateDir: join(dir.path, 'state') })),
  });
  const elsewhere = async (change: (store: RecordStore) => void) => {
    const other = await openRecords({ stateDir: join(dir.path, 'state') });
    change(other);
    other.close();
  };
  const at = (name: string) => join(dir.path, name);
  await mkdir(at('etc'));
  return {
    advance: (ms: number) => {
      now += ms;
    },
    at,
    checks,
    elsewhere,
    now: () => now,
    warnings,
  };
};

test('no section exists until the first pass has run', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);

  expect(c.checks.latest()).toBeUndefined();
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({ files: [] });
});

test('a changed file is drifted and a deleted file is missing, each since the pass that saw it', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await writeFile(c.at('etc/a.conf'), 'one');
  await writeFile(c.at('etc/b.conf'), 'two');
  await writeFile(c.at('etc/c.conf'), 'three');
  await c.elsewhere((store) =>
    store.put(
      'files',
      record('app', {
        [c.at('etc/a.conf')]: 'one',
        [c.at('etc/b.conf')]: 'two',
        [c.at('etc/c.conf')]: 'three',
      }),
    ),
  );
  await c.checks.tick();
  await writeFile(c.at('etc/a.conf'), 'changed');
  await rm(c.at('etc/b.conf'));
  c.advance(RECHECK_MS);

  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    files: [
      { path: c.at('etc/a.conf'), record: 'app', since: c.now(), state: 'drifted' },
      { path: c.at('etc/b.conf'), record: 'app', since: c.now(), state: 'missing' },
    ],
  });
});

test('a file keeps its since time while it stays in one state, and leaves the list once restored', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await writeFile(c.at('etc/a.conf'), 'changed');
  await c.elsewhere((store) => store.put('files', record('app', { [c.at('etc/a.conf')]: 'one' })));
  await c.checks.tick();
  const first = c.now();

  c.advance(RECHECK_MS);
  await rm(c.at('etc/a.conf'));
  await c.checks.tick();
  const missingAt = c.now();
  c.advance(RECHECK_MS);
  await c.checks.tick();
  const stillMissing = c.checks.latest();
  c.advance(RECHECK_MS);
  await writeFile(c.at('etc/a.conf'), 'one');
  await c.checks.tick();
  c.checks.close();

  expect(first).toBeLessThan(missingAt);
  expect(stillMissing).toEqual({
    files: [{ path: c.at('etc/a.conf'), record: 'app', since: missingAt, state: 'missing' }],
  });
  expect(c.checks.latest()).toEqual({ files: [] });
});

test('a directory, an unreadable file, and a link loop are listed as unreadable, not drifted', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await mkdir(c.at('etc/conf.d'));
  await symlink(c.at('etc/y'), c.at('etc/x'));
  await symlink(c.at('etc/x'), c.at('etc/y'));
  await c.elsewhere((store) =>
    store.put('files', record('app', { [c.at('etc/conf.d')]: 'x', [c.at('etc/x')]: 'x' })),
  );

  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({
    files: [
      { path: c.at('etc/conf.d'), record: 'app', since: START, state: 'unreadable' },
      { path: c.at('etc/x'), record: 'app', since: START, state: 'unreadable' },
    ],
  });
});

test('a change to a files record is checked at once, and an unchanged record is not checked again before the hour', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await writeFile(c.at('etc/a.conf'), 'one');
  await c.checks.tick();
  await writeFile(c.at('etc/a.conf'), 'changed');

  await c.checks.tick();
  const unchanged = c.checks.latest();
  await c.elsewhere((store) => store.put('files', record('app', { [c.at('etc/a.conf')]: 'one' })));
  c.advance(1000);
  await c.checks.tick();
  c.checks.close();

  expect(unchanged).toEqual({ files: [] });
  expect(c.checks.latest()).toEqual({
    files: [{ path: c.at('etc/a.conf'), record: 'app', since: c.now(), state: 'drifted' }],
  });
});

test('the section is the same object until a pass runs, so the reporter can tell it did not change', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.checks.tick();
  const first = c.checks.latest();

  await c.checks.tick();
  const idle = c.checks.latest();
  c.advance(RECHECK_MS);
  await c.checks.tick();
  c.checks.close();

  expect(idle).toBe(first);
  expect(c.checks.latest()).not.toBe(first);
  expect(c.checks.latest()).toEqual(first);
});

test('a forgotten record leaves the list', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await c.elsewhere((store) => store.put('files', record('app', { [c.at('etc/a.conf')]: 'one' })));
  await c.checks.tick();
  const before = c.checks.latest();

  await c.elsewhere((store) => store.forget('files', 'app'));
  await c.checks.tick();
  c.checks.close();

  expect(before).toEqual({
    files: [{ path: c.at('etc/a.conf'), record: 'app', since: START, state: 'missing' }],
  });
  expect(c.checks.latest()).toEqual({ files: [] });
});

test('only files a files record names are checked', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await writeFile(c.at('etc/a.conf'), 'one');
  await writeFile(c.at('etc/manifest.json'), '{"files": []}');
  await c.elsewhere((store) => {
    store.put('files', record('app', { [c.at('etc/a.conf')]: 'one' }));
    store.put('application', { name: 'webapp', version: '1.0.0' });
  });

  await c.checks.tick();
  await rm(c.at('etc/manifest.json'));
  c.advance(RECHECK_MS);
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual({ files: [] });
});

test('a store that cannot be opened warns once and is tried again on the next tick', async () => {
  await using dir = await tempStateDir();
  let failing = true;
  const c = await setup(dir, () =>
    failing
      ? Promise.reject(new Error('disk is full'))
      : openRecords({ stateDir: join(dir.path, 'state') }),
  );

  await c.checks.tick();
  await c.checks.tick();
  failing = false;
  await c.checks.tick();
  c.checks.close();

  expect(c.warnings).toEqual(['Could not read the records to check: disk is full']);
  expect(c.checks.latest()).toEqual({ files: [] });
});
