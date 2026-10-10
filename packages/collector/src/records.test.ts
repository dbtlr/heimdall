import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { JobRecord } from '@heimdall/schema';

import { openRecords } from './records.ts';
import { tempStateDir } from './testing/fixtures.ts';

const DAY_MS = 86_400_000;
const START = Date.parse('2026-01-01T00:00:00Z');

const job: JobRecord = {
  name: 'backup',
  schedule: [{ hour: 3 }],
  scheduler: 'systemd-timer',
  unit: 'backup.timer',
};

const run = (day: number, exitStatus = 0) => ({
  exitStatus,
  finished: new Date(START + day * DAY_MS + 5000).toISOString().replace('.000Z', 'Z'),
  started: new Date(START + day * DAY_MS).toISOString().replace('.000Z', 'Z'),
});

const stored = async (stateDir: string) => {
  const store = await openRecords({ stateDir });
  try {
    return store.read();
  } finally {
    store.close();
  }
};

test('a run is pruned once it is more than 90 days old, by the clock the store was given', async () => {
  await using dir = await tempStateDir();
  let now = START;
  const store = await openRecords({ now: () => now, stateDir: dir.path });
  store.put('job', job);
  store.putRun('backup', run(0, 1));
  store.putRun('backup', run(1, 1));

  now = START + 90 * DAY_MS;
  store.putRun('backup', run(90, 1));
  const atNinety = store.read().runs.map((entry) => entry.run.started);
  now = START + 91 * DAY_MS + 1;
  store.putRun('backup', run(91, 1));
  const afterNinety = store.read().runs.map((entry) => entry.run.started);
  store.close();

  // Exactly 90 days old stays; older goes, whatever came first.
  expect(atNinety).toEqual([run(0).started, run(1).started, run(90).started]);
  expect(afterNinety).toEqual([run(90).started, run(91).started]);
});

test('the latest successful run is kept however old, and only the latest', async () => {
  await using dir = await tempStateDir();
  let now = START;
  const store = await openRecords({ now: () => now, stateDir: dir.path });
  store.put('job', job);
  store.putRun('backup', run(0));
  store.putRun('backup', run(1));

  now = START + 200 * DAY_MS;
  store.putRun('backup', run(199, 1));
  const kept = store.read().runs.map((entry) => entry.run.started);
  store.close();

  expect(kept).toEqual([run(1).started, run(199).started]);
});

test('the runs of a job are pruned apart from another job', async () => {
  await using dir = await tempStateDir();
  let now = START;
  const store = await openRecords({ now: () => now, stateDir: dir.path });
  store.put('job', job);
  store.put('job', { ...job, name: 'sync' });
  store.putRun('sync', run(0, 1));

  now = START + 200 * DAY_MS;
  store.putRun('backup', run(199, 1));
  const kept = store.read().runs.map((entry) => entry.job);
  store.close();

  // Recording a run of one job does not prune another's.
  expect(kept).toEqual(['backup', 'sync']);
});

test('records persist across opens and a job that is re-recorded keeps its runs', async () => {
  await using dir = await tempStateDir();
  const first = await openRecords({ stateDir: dir.path });
  first.put('job', job);
  first.putRun('backup', run(0));
  first.close();

  const second = await openRecords({ stateDir: dir.path });
  second.put('job', { ...job, schedule: [{ hour: 4 }] });
  const read = second.read();
  second.close();

  expect(read.records).toEqual([
    { kind: 'job', name: 'backup', record: { ...job, schedule: [{ hour: 4 }] } },
  ]);
  expect(read.runs).toHaveLength(1);
});

test('rows this build cannot read come back as unreadable, not as records, so none vanishes unseen', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ stateDir: dir.path });
  store.put('application', { name: 'fine', version: '1' });
  store.put('job', job);
  store.putRun('backup', run(0));
  store.close();
  // What a newer Collector, or a rollback after one, leaves behind.
  const db = new Database(join(dir.path, 'records.sqlite'));
  const insert = db.query('INSERT INTO records (kind, name, body) VALUES (?, ?, ?)');
  insert.run('application', 'newer', JSON.stringify({ channel: 'x', name: 'newer', version: '2' }));
  insert.run('widget', 'future', JSON.stringify({ name: 'future' }));
  insert.run('files', 'broken', '{not json');
  db.query(
    'INSERT INTO runs (job, started, startedMs, exitStatus, body) VALUES (?, ?, ?, ?, ?)',
  ).run(
    'backup',
    '2026-01-02T00:00:00Z',
    Date.parse('2026-01-02T00:00:00Z'),
    0,
    '{"surprise":true}',
  );
  db.close();

  const read = await stored(dir.path);

  expect(read.records.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
    'application:fine',
    'job:backup',
  ]);
  expect(read.runs).toHaveLength(1);
  expect(read.unreadable).toEqual({
    records: [
      { kind: 'application', name: 'newer' },
      { kind: 'files', name: 'broken' },
      { kind: 'widget', name: 'future' },
    ],
    runs: [{ job: 'backup', started: '2026-01-02T00:00:00Z' }],
  });
});

test('nothing is unreadable when every row reads', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ stateDir: dir.path });
  store.put('job', job);

  expect(store.read().unreadable).toEqual({ records: [], runs: [] });
  store.close();
});

test('putRun says whether it kept the run: kept, expired, or for a job nobody recorded', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ now: () => START + 200 * DAY_MS, stateDir: dir.path });
  store.put('job', job);

  const outcomes = [
    store.putRun('ghost', run(199)),
    store.putRun('backup', run(199, 1)),
    // Older than 90 days and not the latest success: pruned in the same transaction.
    store.putRun('backup', run(10, 1)),
    // The latest success is kept however old.
    store.putRun('backup', run(5)),
  ];
  const kept = store.read().runs.map((entry) => entry.run.started);
  store.close();

  expect(outcomes).toEqual(['no job', 'kept', 'expired', 'kept']);
  expect(kept).toEqual([run(5).started, run(199).started]);
});

test('latestRuns gives each job its latest run and latest success, whatever order they were recorded in', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ now: () => START + 10 * DAY_MS, stateDir: dir.path });
  store.put('job', job);
  store.put('job', { ...job, name: 'sync' });
  store.put('job', { ...job, name: 'idle' });
  for (const day of [3, 1, 4]) {
    store.putRun('backup', run(day, day === 4 ? 1 : 0));
  }
  store.putRun('sync', run(2, 1));
  const latest = store.latestRuns();
  store.close();

  // `idle` has no runs, so it is in neither list. `backup` failed last, so its latest run and success differ.
  expect(latest).toEqual({
    jobs: [
      { job: 'backup', latestRun: run(4, 1), latestSuccess: run(3) },
      { job: 'sync', latestRun: run(2, 1), latestSuccess: null },
    ],
    unreadable: [],
  });
});

test('latestRuns names a job whose latest run or latest success it cannot read, and still reads the others', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ now: () => START + 10 * DAY_MS, stateDir: dir.path });
  for (const name of ['backup', 'sync', 'tidy']) {
    store.put('job', { ...job, name });
  }
  store.putRun('backup', run(1));
  store.putRun('backup', run(2, 1));
  store.putRun('sync', run(1));
  store.putRun('tidy', run(1));
  store.close();
  const db = new Database(join(dir.path, 'records.sqlite'));
  const damage = db.query('UPDATE runs SET body = $body WHERE job = $job AND started = $started');
  // The latest run of backup, and the only success of sync, are damaged.
  damage.run({ $body: '{"surprise":true}', $job: 'backup', $started: run(2).started });
  damage.run({ $body: '{not json', $job: 'sync', $started: run(1).started });
  db.close();

  const reopened = await openRecords({ stateDir: dir.path });
  const latest = reopened.latestRuns();
  reopened.close();

  expect(latest).toEqual({
    jobs: [{ job: 'tidy', latestRun: run(1), latestSuccess: run(1) }],
    unreadable: ['backup', 'sync'],
  });
});

test('latestRuns names a job whose latest success it cannot read, though its latest run reads', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ now: () => START + 10 * DAY_MS, stateDir: dir.path });
  store.put('job', job);
  store.putRun('backup', run(1));
  store.putRun('backup', run(2, 1));
  store.close();
  const db = new Database(join(dir.path, 'records.sqlite'));
  db.query('UPDATE runs SET body = $body WHERE started = $started').run({
    $body: '{not json',
    $started: run(1).started,
  });
  db.close();

  const reopened = await openRecords({ stateDir: dir.path });
  const latest = reopened.latestRuns();
  reopened.close();

  expect(latest).toEqual({ jobs: [], unreadable: ['backup'] });
});

test('latestRuns and readRecords read no run beyond the latest ones', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ now: () => START + 10 * DAY_MS, stateDir: dir.path });
  store.put('job', job);
  store.putRun('backup', run(1));
  store.putRun('backup', run(2));
  store.putRun('backup', run(3));
  store.close();
  const db = new Database(join(dir.path, 'records.sqlite'));
  // Neither the oldest run nor the middle one is the latest or the latest success.
  db.query('UPDATE runs SET body = $body WHERE startedMs < $cutoff').run({
    $body: '{not json',
    $cutoff: START + 3 * DAY_MS,
  });
  db.close();

  const reopened = await openRecords({ stateDir: dir.path });
  const latest = reopened.latestRuns();
  const records = reopened.readRecords();
  reopened.close();

  expect(latest).toEqual({
    jobs: [{ job: 'backup', latestRun: run(3), latestSuccess: run(3) }],
    unreadable: [],
  });
  expect(records.records.map(({ name }) => name)).toEqual(['backup']);
  expect(records.unreadable).toEqual([]);
});

test('a forgotten job has no latest runs', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ now: () => START + 10 * DAY_MS, stateDir: dir.path });
  store.put('job', job);
  store.putRun('backup', run(1));
  store.forget('job', 'backup');
  const latest = store.latestRuns();
  store.close();

  expect(latest).toEqual({ jobs: [], unreadable: [] });
});

test('the database is in WAL mode, which lets a reader proceed while another process writes', async () => {
  await using dir = await tempStateDir();
  (await openRecords({ stateDir: dir.path })).close();

  const db = new Database(join(dir.path, 'records.sqlite'));
  const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
  db.close();

  expect(mode?.journal_mode).toBe('wal');
});

// A process that takes the write lock on the records database, inserts a record,
// and commits `holdMs` later, as `heimdall-collector record` in another process would.
const HOLDER = `
import { Database } from 'bun:sqlite';
const [path, holdMs] = process.argv.slice(1);
const db = new Database(path);
db.run('BEGIN IMMEDIATE');
db.query("INSERT INTO records (kind, name, body) VALUES ('application', 'held', ?)").run(JSON.stringify({ name: 'held', version: '1' }));
console.log('locked');
await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
db.run('COMMIT');
`;

const holdWriteLock = async (stateDir: string, holdMs: number) => {
  const child = Bun.spawn(
    [process.execPath, '-e', HOLDER, join(stateDir, 'records.sqlite'), String(holdMs)],
    { stdout: 'pipe' },
  );
  await child.stdout.getReader().read();
  return child;
};

test('a write waits for another process holding the write lock instead of failing', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ stateDir: dir.path });
  store.put('job', job);
  const holder = await holdWriteLock(dir.path, 300);

  // The holder commits a change during the wait, so a transaction that began
  // reading before it would lose its snapshot; a write transaction begun with
  // BEGIN IMMEDIATE waits for the lock first and sees the change.
  const outcome = store.putRun('backup', run(0));
  const forgotten = store.forget('application', 'held');
  await holder.exited;
  const read = store.read();
  store.close();

  expect(outcome).toBe('kept');
  expect(forgotten).toBe(true);
  expect(read.runs).toHaveLength(1);
  expect(read.records.map(({ name }) => name)).toEqual(['backup']);
});

// The file descriptors this process holds open.
const openFiles = async () => (await readdir('/dev/fd')).length;

// Whether opening the store in `stateDir` fails.
const openFails = async (stateDir: string) => {
  try {
    (await openRecords({ stateDir })).close();
    return false;
  } catch {
    return true;
  }
};

// The daemon retries a store that fails to open on every flush, so a failed
// open must not hold a file descriptor.
test.each([
  ['is not a database', async (path: string) => Bun.write(path, 'this is not a database')],
  [
    'has tables of another shape',
    async (path: string) => {
      const db = new Database(path, { create: true });
      db.run('CREATE TABLE records (x TEXT)');
      db.close();
    },
  ],
])('a records file that %s fails to open and leaves no handle open', async (_case, make) => {
  await using dir = await tempStateDir();
  await make(join(dir.path, 'records.sqlite'));
  const before = await openFiles();

  for (let i = 0; i < 5; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- each open must fail before the next.
    expect(await openFails(dir.path)).toBe(true);
  }

  expect(await openFiles()).toBe(before);
});
