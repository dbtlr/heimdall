import { expect, test } from 'bun:test';

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
