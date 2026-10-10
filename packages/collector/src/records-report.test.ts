import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RecordsSectionSchema } from '@heimdall/schema';
import type { ApplicationRecord, JobRecord, Report } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { flushQueue } from './delivery.ts';
import type { Delivery } from './delivery.ts';
import { openQueue } from './queue.ts';
import { createRecordsReporter, RECORDS_REFRESH_MS } from './records-report.ts';
import { openRecords } from './records.ts';
import type { RecordStore } from './records.ts';
import { tempStateDir } from './testing/fixtures.ts';

const identity = {
  collector: { arch: 'x64', platform: 'linux', version: '0.0.0' },
  system: 'server-1',
} as const;

const NO_TRANSCRIPTS = { sources: [], spool: { bytes: 0, oldestAt: null } };

const webapp: ApplicationRecord = { name: 'webapp', version: '1.4.2' };
const cron: JobRecord = {
  name: 'backup',
  schedule: [{ hour: 3 }],
  scheduler: 'systemd-timer',
  unit: 'backup.timer',
};

// A Collector's records and queue in a fresh state directory, with a Hub that
// answers each Report with `respond`, or else with the next scripted outcome.
// `open` is how the reporter gets its store. `push` queues a sample and
// flushes, as one interval of the daemon does, and returns the Reports sent.
const setup = async (
  dir: { path: string },
  {
    batchSize,
    maxBytes,
    open = () => openRecords({ stateDir: dir.path }),
    respond,
  }: {
    batchSize?: number;
    maxBytes?: number;
    open?: () => Promise<RecordStore>;
    respond?: (report: Report) => Delivery;
  } = {},
) => {
  const queue = await openQueue({ capacity: 100, stateDir: dir.path });
  const warnings: string[] = [];
  let now = 1_000_000;
  const outcomes: Delivery[] = [];
  const reports: Report[] = [];
  const reporter = createRecordsReporter({
    log: { info: () => 0, warn: (m) => warnings.push(m) },
    ...(maxBytes === undefined ? {} : { maxBytes }),
    now: () => now,
    open,
  });
  let t = 0;
  const push = async (samples = 1) => {
    const before = reports.length;
    for (let i = 0; i < samples; i += 1) {
      t += 1;
      queue.append(sample(t));
    }
    await flushQueue({
      ...(batchSize === undefined ? {} : { batchSize }),
      identity,
      now: () => now,
      queue,
      records: reporter,
      send: (report) => {
        reports.push(report);
        return Promise.resolve(respond?.(report) ?? outcomes.shift() ?? { kind: 'delivered' });
      },
      transcripts: () => NO_TRANSCRIPTS,
    });
    return reports.slice(before);
  };
  return {
    advance: (ms: number) => {
      now += ms;
    },
    close: () => {
      queue.close();
      reporter.close();
    },
    outcomes,
    push,
    queue,
    reporter,
    warnings,
  };
};

// Applies `change` through a connection of its own, as `record` and `forget` do.
const elsewhere = async (
  stateDir: string,
  change: (store: Awaited<ReturnType<typeof openRecords>>) => void,
) => {
  const other = await openRecords({ stateDir });
  change(other);
  other.close();
};

test('the first Report after start carries the record set, and the next does not while it is unchanged', async () => {
  await using dir = await tempStateDir();
  const store = await openRecords({ stateDir: dir.path });
  store.put('application', webapp);
  store.close();
  const collector = await setup(dir);

  const first = await collector.push();
  const second = await collector.push();
  collector.close();

  expect(first[0]?.records).toEqual({
    records: [{ kind: 'application', name: 'webapp', record: webapp }],
    unreadable: [],
  });
  expect(second[0]?.records).toBeUndefined();
});

test('an empty store, created by the daemon, sends an empty set once', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir);

  const first = await collector.push();
  const second = await collector.push();
  collector.close();

  expect(first[0]?.records).toEqual({ records: [], unreadable: [] });
  expect(second[0]?.records).toBeUndefined();
});

test('a record written by another process makes the next Report carry the whole new set', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir);
  await collector.push();

  await elsewhere(dir.path, (other) => other.put('application', webapp));
  const afterRecord = await collector.push();
  await elsewhere(dir.path, (other) => other.put('job', cron));
  const afterSecond = await collector.push();
  await elsewhere(dir.path, (other) => other.forget('application', 'webapp'));
  const afterForget = await collector.push();
  collector.close();

  expect(afterRecord[0]?.records).toEqual({
    records: [{ kind: 'application', name: 'webapp', record: webapp }],
    unreadable: [],
  });
  expect(afterSecond[0]?.records).toEqual({
    records: [
      { kind: 'application', name: 'webapp', record: webapp },
      { kind: 'job', name: 'backup', record: cron },
    ],
    unreadable: [],
  });
  expect(afterForget[0]?.records).toEqual({
    records: [{ kind: 'job', name: 'backup', record: cron }],
    unreadable: [],
  });
});

test('recording only a run, or recording identical content again, sends nothing new', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('job', cron);
  seed.close();
  const collector = await setup(dir);
  await collector.push();

  const started = new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  await elsewhere(dir.path, (other) =>
    other.putRun('backup', { exitStatus: 0, finished: started, started }),
  );
  const afterRun = await collector.push();
  await elsewhere(dir.path, (other) => other.put('job', cron));
  const afterSame = await collector.push();
  collector.close();

  expect(afterRun[0]?.records).toBeUndefined();
  expect(afterSame[0]?.records).toBeUndefined();
});

test('rows this build cannot read travel as unreadable, beside the records it can', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('application', webapp);
  seed.close();
  const db = new Database(join(dir.path, 'records.sqlite'));
  db.run("INSERT INTO records (kind, name, body) VALUES ('gadget', 'g1', '{}')");
  db.run("INSERT INTO records (kind, name, body) VALUES ('job', 'broken', '{\"name\":1}')");
  db.close();
  const collector = await setup(dir);

  const [report] = await collector.push();
  collector.close();

  expect(report?.records).toEqual({
    records: [{ kind: 'application', name: 'webapp', record: webapp }],
    unreadable: [
      { kind: 'gadget', name: 'g1' },
      { kind: 'job', name: 'broken' },
    ],
  });
});

test('an hour after the last delivered set, the set is sent again though unchanged', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir);
  await collector.push();

  collector.advance(RECORDS_REFRESH_MS - 1);
  const justBefore = await collector.push();
  collector.advance(1);
  const atTheHour = await collector.push();
  const after = await collector.push();
  collector.close();

  expect(justBefore[0]?.records).toBeUndefined();
  expect(atTheHour[0]?.records).toEqual({ records: [], unreadable: [] });
  expect(after[0]?.records).toBeUndefined();
});

test('a failed delivery keeps the set pending for the next Report', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir);
  collector.outcomes.push({ kind: 'failed', reason: 'Hub answered 503' });

  const failed = await collector.push();
  await elsewhere(dir.path, (other) => other.put('application', webapp));
  const retried = await collector.push();
  const after = await collector.push();
  collector.close();

  expect(failed[0]?.records).toEqual({ records: [], unreadable: [] });
  // The retry carries the set as it is now, not as it was when the attempt failed.
  expect(retried[0]?.records).toEqual({
    records: [{ kind: 'application', name: 'webapp', record: webapp }],
    unreadable: [],
  });
  expect(after[0]?.records).toBeUndefined();
});

test('a rejected Report counts the set as sent and logs it once, and the hourly refresh retries it', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir);
  collector.outcomes.push({ detail: 'bad records', kind: 'rejected' });

  const rejected = await collector.push();
  const next = await collector.push();
  collector.advance(RECORDS_REFRESH_MS);
  const hourly = await collector.push();
  collector.close();

  expect(rejected[0]?.records).toBeDefined();
  expect(next[0]?.records).toBeUndefined();
  expect(hourly[0]?.records).toBeDefined();
  expect(collector.warnings).toHaveLength(1);
  expect(collector.warnings[0]).toContain('bad records');
});

test('a multi-batch flush carries the set on its first Report only', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir, { batchSize: 2 });

  const reports = await collector.push(5);
  collector.close();

  expect(reports).toHaveLength(3);
  expect(reports.map((report) => report.records !== undefined)).toEqual([true, false, false]);
});

test('a set over budget travels as its size alone', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('application', webapp);
  seed.close();
  const expected = Buffer.byteLength(
    JSON.stringify({
      records: [{ kind: 'application', name: 'webapp', record: webapp }],
      unreadable: [],
    }),
  );
  const collector = await setup(dir, { maxBytes: expected - 1 });

  const [report] = await collector.push();
  collector.close();

  expect(report?.records).toEqual({ overBudget: { bytes: expected } });
});

test('a set exactly at the budget is sent whole', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir, {
    maxBytes: Buffer.byteLength('{"records":[],"unreadable":[]}'),
  });

  const [report] = await collector.push();
  collector.close();

  expect(report?.records).toEqual({ records: [], unreadable: [] });
});

test('a set the Hub refuses never costs the samples: they are resent without it, and the set is settled', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir, {
    respond: (report) =>
      report.records === undefined
        ? { kind: 'delivered' }
        : { detail: 'bad records', kind: 'rejected' },
  });

  const first = await collector.push(2);
  const next = await collector.push();
  const remaining = collector.queue.oldest(10);
  collector.close();

  expect(first.map((report) => report.records !== undefined)).toEqual([true, false]);
  expect(first[1]?.samples).toEqual(first[0]?.samples);
  expect(next.map((report) => report.records)).toEqual([undefined]);
  expect(remaining).toEqual([]);
  expect(collector.warnings).toHaveLength(1);
  expect(collector.warnings[0]).toContain('bad records');
});

test('rows the section cannot carry are left out and warned about, and the section stays valid', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('application', webapp);
  seed.close();
  const db = new Database(join(dir.path, 'records.sqlite'));
  const insert = db.query('INSERT INTO records (kind, name, body) VALUES ($kind, $name, $body)');
  const body = JSON.stringify(webapp);
  insert.run({ $body: body, $kind: 'application', $name: '../escape' });
  insert.run({ $body: body, $kind: 'application', $name: 'alias' });
  insert.run({ $body: '{}', $kind: 'job', $name: 'x'.repeat(129) });
  insert.run({ $body: '{}', $kind: '', $name: 'empty-kind' });
  insert.run({ $body: '{}', $kind: 'k'.repeat(65), $name: 'long-kind' });
  insert.run({ $body: '{}', $kind: 'gadget', $name: 'has space' });
  db.close();
  const collector = await setup(dir);

  const [report] = await collector.push();
  collector.close();

  expect(RecordsSectionSchema.safeParse(report?.records).success).toBe(true);
  expect(report?.records).toEqual({
    records: [{ kind: 'application', name: 'webapp', record: webapp }],
    unreadable: [{ kind: 'application', name: 'alias' }],
  });
  expect(collector.warnings).toHaveLength(1);
  expect(collector.warnings[0]).toContain('../escape');
  expect(collector.warnings[0]).toContain('has space');
});

test('a set over budget is not sent again when it changes without changing size', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('application', webapp);
  seed.close();
  const collector = await setup(dir, { maxBytes: 10 });

  const first = await collector.push();
  await elsewhere(dir.path, (other) => other.put('application', { ...webapp, version: '1.4.3' }));
  const second = await collector.push();
  collector.close();

  expect(first[0]?.records).toHaveProperty('overBudget');
  expect(second[0]?.records).toBeUndefined();
});

test('a records file that cannot be opened costs the records only, and is tried again later', async () => {
  await using dir = await tempStateDir();
  await writeFile(join(dir.path, 'records.sqlite'), 'this is not a database');
  const collector = await setup(dir);

  const first = await collector.push();
  const second = await collector.push();
  await rm(join(dir.path, 'records.sqlite'), { force: true });
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('application', webapp);
  seed.close();
  const third = await collector.push();
  collector.close();

  expect(first).toHaveLength(1);
  expect(first[0]?.samples).toHaveLength(1);
  expect(first[0]?.records).toBeUndefined();
  expect(second[0]?.records).toBeUndefined();
  expect(collector.warnings).toHaveLength(1);
  expect(third[0]?.records).toEqual({
    records: [{ kind: 'application', name: 'webapp', record: webapp }],
    unreadable: [],
  });
});

test('a store that cannot be read costs the records only, and is warned about once', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir, {
    open: async () => ({
      ...(await openRecords({ stateDir: dir.path })),
      read: () => {
        throw new Error('disk gone');
      },
    }),
  });

  const first = await collector.push();
  const second = await collector.push();
  collector.close();

  expect(first[0]?.samples).toHaveLength(1);
  expect(second[0]?.samples).toHaveLength(1);
  expect(first[0]?.records).toBeUndefined();
  expect(second[0]?.records).toBeUndefined();
  expect(collector.warnings).toHaveLength(1);
  expect(collector.warnings[0]).toContain('disk gone');
});

test('a write landing between the version read and the set read is not missed', async () => {
  await using dir = await tempStateDir();
  const other = await openRecords({ stateDir: dir.path });
  const collector = await setup(dir, {
    open: async () => {
      const store = await openRecords({ stateDir: dir.path });
      let landed = false;
      return {
        ...store,
        // The other process commits just after the first read, which is the
        // moment a version read taken after the set would swallow the write.
        read: () => {
          const read = store.read();
          if (!landed) {
            landed = true;
            other.put('application', webapp);
          }
          return read;
        },
      };
    },
  });

  const first = await collector.push();
  const second = await collector.push();
  collector.close();
  other.close();

  expect(first[0]?.records).toEqual({ records: [], unreadable: [] });
  expect(second[0]?.records).toEqual({
    records: [{ kind: 'application', name: 'webapp', record: webapp }],
    unreadable: [],
  });
});
