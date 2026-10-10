import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { filesRecordDigest } from '@heimdall/schema';
import type { ChecksSection, FilesRecord } from '@heimdall/schema';

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

// The checks section for a pass that hashed `records` and found `files`.
const section = async (
  records: FilesRecord[],
  files: { path: string; record: string; since: number; state: string }[] = [],
) => ({
  fileRecords: await Promise.all(
    records.map(async (r) => ({ digest: await filesRecordDigest(r), record: r.name })),
  ),
  files,
});

// The files records a checks section lists as hashed, which a size alone lacks.
const fileRecordsOf = (checks: ChecksSection | undefined) =>
  checks !== undefined && 'fileRecords' in checks ? checks.fileRecords : undefined;

// The files a checks section lists as not matching, which a size alone lacks.
const filesOf = (checks: ChecksSection | undefined) =>
  checks !== undefined && 'files' in checks ? checks.files : undefined;

// A Collector's records in a fresh state directory and files in another, with
// the checks over them on a clock the test sets. `elsewhere` changes the
// records through a connection of their own, as `record` and `forget` do.
const setup = async (
  dir: { path: string },
  { open, signal }: { open?: () => Promise<RecordStore>; signal?: AbortSignal } = {},
) => {
  const warnings: string[] = [];
  let now = START;
  const checks = createChecks({
    log: { info: () => 0, warn: (m) => warnings.push(m) },
    now: () => now,
    open: open ?? (() => openRecords({ stateDir: join(dir.path, 'state') })),
    ...(signal === undefined ? {} : { signal }),
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

  expect(c.checks.latest()).toEqual({ fileRecords: [], files: [] });
});

test('a changed file is drifted and a deleted file is missing, each since the pass that saw it', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await writeFile(c.at('etc/a.conf'), 'one');
  await writeFile(c.at('etc/b.conf'), 'two');
  await writeFile(c.at('etc/c.conf'), 'three');
  const app = record('app', {
    [c.at('etc/a.conf')]: 'one',
    [c.at('etc/b.conf')]: 'two',
    [c.at('etc/c.conf')]: 'three',
  });
  await c.elsewhere((store) => store.put('files', app));
  await c.checks.tick();
  await writeFile(c.at('etc/a.conf'), 'changed');
  await rm(c.at('etc/b.conf'));
  c.advance(RECHECK_MS);

  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual(
    await section(
      [app],
      [
        { path: c.at('etc/a.conf'), record: 'app', since: c.now(), state: 'drifted' },
        { path: c.at('etc/b.conf'), record: 'app', since: c.now(), state: 'missing' },
      ],
    ),
  );
});

test('a file keeps its since time while it stays in one state, and leaves the list once restored', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await writeFile(c.at('etc/a.conf'), 'changed');
  const app = record('app', { [c.at('etc/a.conf')]: 'one' });
  await c.elsewhere((store) => store.put('files', app));
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
  expect(stillMissing).toEqual(
    await section(
      [app],
      [{ path: c.at('etc/a.conf'), record: 'app', since: missingAt, state: 'missing' }],
    ),
  );
  expect(c.checks.latest()).toEqual(await section([app]));
});

test('a directory, an unreadable file, and a link loop are listed as unreadable, not drifted', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await mkdir(c.at('etc/conf.d'));
  await symlink(c.at('etc/y'), c.at('etc/x'));
  await symlink(c.at('etc/x'), c.at('etc/y'));
  const app = record('app', { [c.at('etc/conf.d')]: 'x', [c.at('etc/x')]: 'x' });
  await c.elsewhere((store) => store.put('files', app));

  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual(
    await section(
      [app],
      [
        { path: c.at('etc/conf.d'), record: 'app', since: START, state: 'unreadable' },
        { path: c.at('etc/x'), record: 'app', since: START, state: 'unreadable' },
      ],
    ),
  );
});

test('a change to a files record is checked at once, and an unchanged record is not checked again before the hour', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await writeFile(c.at('etc/a.conf'), 'one');
  await c.checks.tick();
  await writeFile(c.at('etc/a.conf'), 'changed');

  await c.checks.tick();
  const unchanged = c.checks.latest();
  const app = record('app', { [c.at('etc/a.conf')]: 'one' });
  await c.elsewhere((store) => store.put('files', app));
  c.advance(1000);
  await c.checks.tick();
  c.checks.close();

  expect(unchanged).toEqual(await section([]));
  expect(c.checks.latest()).toEqual(
    await section(
      [app],
      [{ path: c.at('etc/a.conf'), record: 'app', since: c.now(), state: 'drifted' }],
    ),
  );
});

test('recording a run, an application, or the same files record again hashes nothing before the hour', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await writeFile(c.at('etc/a.conf'), 'one');
  const app = record('app', { [c.at('etc/a.conf')]: 'one' });
  await c.elsewhere((store) => {
    store.put('files', app);
    store.put('job', {
      name: 'backup',
      schedule: [{ hour: 3 }],
      scheduler: 'systemd-timer',
      unit: 'backup.timer',
    });
  });
  await c.checks.tick();
  const first = c.checks.latest();
  // A pass now would find the file changed.
  await writeFile(c.at('etc/a.conf'), 'changed');

  await c.elsewhere((store) =>
    store.putRun('backup', {
      exitStatus: 0,
      finished: '2026-10-10T03:00:09Z',
      started: '2026-10-10T03:00:00Z',
    }),
  );
  await c.checks.tick();
  await c.elsewhere((store) => store.put('application', { name: 'webapp', version: '1.0.0' }));
  await c.checks.tick();
  await c.elsewhere((store) => store.put('files', app));
  await c.checks.tick();
  const idle = c.checks.latest();
  c.advance(RECHECK_MS);
  await c.checks.tick();
  c.checks.close();

  expect(idle).toBe(first);
  expect(c.checks.latest()).toEqual(
    await section(
      [app],
      [{ path: c.at('etc/a.conf'), record: 'app', since: c.now(), state: 'drifted' }],
    ),
  );
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
  const app = record('app', { [c.at('etc/a.conf')]: 'one' });
  await c.elsewhere((store) => store.put('files', app));
  await c.checks.tick();
  const before = c.checks.latest();

  await c.elsewhere((store) => store.forget('files', 'app'));
  await c.checks.tick();
  c.checks.close();

  expect(before).toEqual(
    await section(
      [app],
      [{ path: c.at('etc/a.conf'), record: 'app', since: START, state: 'missing' }],
    ),
  );
  expect(c.checks.latest()).toEqual(await section([]));
});

test('only files a files record names are checked', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  await writeFile(c.at('etc/a.conf'), 'one');
  await writeFile(c.at('etc/manifest.json'), '{"files": []}');
  const app = record('app', { [c.at('etc/a.conf')]: 'one' });
  await c.elsewhere((store) => {
    store.put('files', app);
    store.put('application', { name: 'webapp', version: '1.0.0' });
  });

  await c.checks.tick();
  await rm(c.at('etc/manifest.json'));
  c.advance(RECHECK_MS);
  await c.checks.tick();
  c.checks.close();

  expect(c.checks.latest()).toEqual(await section([app]));
});

// Writes a row straight into the Collector's database, as damage would.
const insertRaw = (dir: { path: string }, row: { body: unknown; kind: string; name: string }) => {
  const db = new Database(join(dir.path, 'state', 'records.sqlite'));
  db.run('INSERT INTO records (kind, name, body) VALUES (?, ?, ?)', [
    row.kind,
    row.name,
    JSON.stringify(row.body),
  ]);
  db.close();
};

test('a files row stored under another name, or one the Hub cannot take, is left out with a warning, once', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  const ok = record('app', { [c.at('etc/a.conf')]: 'one' });
  await c.elsewhere((store) => store.put('files', ok));
  insertRaw(dir, {
    body: record('other', { [c.at('etc/b.conf')]: 'x' }),
    kind: 'files',
    name: 'renamed',
  });

  await c.checks.tick();
  c.advance(RECHECK_MS);
  await c.checks.tick();
  c.checks.close();

  expect(fileRecordsOf(c.checks.latest())).toEqual((await section([ok])).fileRecords);
  expect(c.warnings).toEqual([expect.stringContaining('"renamed"')]);
});

test('a files record the Collector cannot read is not among the records it hashed', async () => {
  await using dir = await tempStateDir();
  const c = await setup(dir);
  const ok = record('app', { [c.at('etc/a.conf')]: 'one' });
  await c.elsewhere((store) => store.put('files', ok));
  insertRaw(dir, {
    body: { files: 'not a list', name: 'damaged' },
    kind: 'files',
    name: 'damaged',
  });

  await c.checks.tick();
  c.checks.close();

  expect(fileRecordsOf(c.checks.latest())).toEqual((await section([ok])).fileRecords);
});

test('a pass the signal cuts short replaces nothing', async () => {
  await using dir = await tempStateDir();
  const controller = new AbortController();
  const c = await setup(dir, { signal: controller.signal });
  await writeFile(c.at('etc/a.conf'), 'changed');
  const app = record('app', { [c.at('etc/a.conf')]: 'one' });
  await c.elsewhere((store) => store.put('files', app));
  await c.checks.tick();
  const first = c.checks.latest();

  controller.abort();
  c.advance(RECHECK_MS);
  await c.checks.tick();
  c.checks.close();

  expect(filesOf(first)).toHaveLength(1);
  expect(c.checks.latest()).toBe(first);
});

test('a store that cannot be opened warns once and is tried again on the next tick', async () => {
  await using dir = await tempStateDir();
  let failing = true;
  const c = await setup(dir, {
    open: () =>
      failing
        ? Promise.reject(new Error('disk is full'))
        : openRecords({ stateDir: join(dir.path, 'state') }),
  });

  await c.checks.tick();
  await c.checks.tick();
  failing = false;
  await c.checks.tick();
  c.checks.close();

  expect(c.warnings).toEqual(['Could not read the records to check: disk is full']);
  expect(c.checks.latest()).toEqual(await section([]));
});
