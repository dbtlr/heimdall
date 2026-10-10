import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RecordsSectionSchema, RunsSectionSchema } from '@heimdall/schema';
import type { ApplicationRecord, JobRecord, Report, RunRecord } from '@heimdall/schema';
import { sample } from '@heimdall/schema/testing';

import { flushQueue } from './delivery.ts';
import type { Delivery } from './delivery.ts';
import { openQueue } from './queue.ts';
import { createSectionsReporter, RECORDS_REFRESH_MS } from './records-report.ts';
import { openRecords } from './records.ts';
import type { RecordStore } from './records.ts';
import { NO_TIME_ZONE, tempStateDir } from './testing/fixtures.ts';

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
    maxRecordsBytes,
    maxRunsBytes,
    open = () => openRecords({ stateDir: dir.path }),
    respond,
  }: {
    batchSize?: number;
    maxRecordsBytes?: number;
    maxRunsBytes?: number;
    open?: () => Promise<RecordStore>;
    respond?: (report: Report) => Delivery;
  } = {},
) => {
  const queue = await openQueue({ capacity: 100, stateDir: dir.path });
  const warnings: string[] = [];
  let now = 1_000_000;
  const outcomes: Delivery[] = [];
  const reports: Report[] = [];
  const reporter = createSectionsReporter({
    log: { info: () => 0, warn: (m) => warnings.push(m) },
    ...(maxRecordsBytes === undefined ? {} : { maxRecordsBytes }),
    ...(maxRunsBytes === undefined ? {} : { maxRunsBytes }),
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
      sections: reporter,
      send: (report) => {
        reports.push(report);
        return Promise.resolve(respond?.(report) ?? outcomes.shift() ?? { kind: 'delivered' });
      },
      timeZone: NO_TIME_ZONE,
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

const isoSecond = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

// A run that started `minutes` ago, as the Collector keeps it.
const minutesAgo = (minutes: number, exitStatus = 0): RunRecord => {
  const started = Date.now() - minutes * 60_000;
  return { exitStatus, finished: isoSecond(started + 5000), started: isoSecond(started) };
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

test('recording identical content again sends nothing new', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  const ran = minutesAgo(10);
  seed.put('job', cron);
  seed.putRun('backup', ran);
  seed.close();
  const collector = await setup(dir);
  await collector.push();

  await elsewhere(dir.path, (other) => other.put('job', cron));
  await elsewhere(dir.path, (other) => other.putRun('backup', ran));
  const afterSame = await collector.push();
  collector.close();

  expect(afterSame[0]?.records).toBeUndefined();
  expect(afterSame[0]?.runs).toBeUndefined();
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

test('a rejected Report counts both sections as sent and logs each once, and the hourly refresh retries them', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir);
  collector.outcomes.push({ detail: 'bad records', kind: 'rejected' });

  const rejected = await collector.push();
  const next = await collector.push();
  collector.advance(RECORDS_REFRESH_MS);
  const hourly = await collector.push();
  collector.close();

  expect(rejected[0]).toMatchObject({ records: expect.anything(), runs: expect.anything() });
  expect(next[0]?.records).toBeUndefined();
  expect(next[0]?.runs).toBeUndefined();
  expect(hourly[0]).toMatchObject({ records: expect.anything(), runs: expect.anything() });
  expect(collector.warnings).toHaveLength(2);
  expect(collector.warnings[0]).toContain('carrying the records (bad records)');
  expect(collector.warnings[1]).toContain('carrying the runs (bad records)');
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
  const collector = await setup(dir, { maxRecordsBytes: expected - 1 });

  const [report] = await collector.push();
  collector.close();

  expect(report?.records).toEqual({ overBudget: { bytes: expected } });
});

test('a set exactly at the budget is sent whole', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir, {
    maxRecordsBytes: Buffer.byteLength('{"records":[],"unreadable":[]}'),
  });

  const [report] = await collector.push();
  collector.close();

  expect(report?.records).toEqual({ records: [], unreadable: [] });
});

test('sections the Hub refuses never cost the samples: they are resent without them, and the sections are settled', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir, {
    respond: (report) =>
      report.records === undefined && report.runs === undefined
        ? { kind: 'delivered' }
        : { detail: 'bad records', kind: 'rejected' },
  });

  const first = await collector.push(2);
  const next = await collector.push();
  const remaining = collector.queue.oldest(10);
  collector.close();

  expect(first.map((report) => [report.records !== undefined, report.runs !== undefined])).toEqual([
    [true, true],
    [false, false],
  ]);
  expect(first[1]?.samples).toEqual(first[0]?.samples);
  expect(next.map((report) => [report.records, report.runs])).toEqual([[undefined, undefined]]);
  expect(remaining).toEqual([]);
  expect(collector.warnings).toHaveLength(2);
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
  const collector = await setup(dir, { maxRecordsBytes: 10 });

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

test('a store that cannot be read costs the records and runs only, and is warned about once', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir, {
    open: async () => ({
      ...(await openRecords({ stateDir: dir.path })),
      readRecords: () => {
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
  expect(first[0]?.runs).toBeUndefined();
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
        readRecords: () => {
          const read = store.readRecords();
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

test("the first Report after start carries each job's latest runs, and the next does not while they are unchanged", async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  const succeeded = minutesAgo(20);
  const failed = minutesAgo(10, 1);
  seed.put('job', cron);
  seed.put('job', { ...cron, name: 'idle' });
  seed.putRun('backup', succeeded);
  seed.putRun('backup', failed);
  seed.close();
  const collector = await setup(dir);

  const first = await collector.push();
  const second = await collector.push();
  collector.close();

  // `idle` has no runs, so it is not in the section.
  expect(first[0]?.runs).toEqual({
    jobs: [{ job: 'backup', latestRun: failed, latestSuccess: succeeded }],
    unreadable: [],
  });
  expect(RunsSectionSchema.safeParse(first[0]?.runs).success).toBe(true);
  expect(second[0]?.runs).toBeUndefined();
});

test('a store with no runs sends an empty runs section once', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir);

  const first = await collector.push();
  const second = await collector.push();
  collector.close();

  expect(first[0]?.runs).toEqual({ jobs: [], unreadable: [] });
  expect(second[0]?.runs).toBeUndefined();
});

test('recording a run sends the runs section and not the record set', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('job', cron);
  seed.close();
  const collector = await setup(dir);
  await collector.push();

  const first = minutesAgo(30);
  const second = minutesAgo(5, 1);
  await elsewhere(dir.path, (other) => other.putRun('backup', first));
  const afterFirst = await collector.push();
  await elsewhere(dir.path, (other) => other.putRun('backup', second));
  const afterSecond = await collector.push();
  collector.close();

  expect(afterFirst[0]?.records).toBeUndefined();
  expect(afterFirst[0]?.runs).toEqual({
    jobs: [{ job: 'backup', latestRun: first, latestSuccess: first }],
    unreadable: [],
  });
  expect(afterSecond[0]?.records).toBeUndefined();
  expect(afterSecond[0]?.runs).toEqual({
    jobs: [{ job: 'backup', latestRun: second, latestSuccess: first }],
    unreadable: [],
  });
});

test('recording a record sends the set and not the runs, unless the change moved the runs', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('job', cron);
  seed.putRun('backup', minutesAgo(10));
  seed.close();
  const collector = await setup(dir);
  await collector.push();

  await elsewhere(dir.path, (other) => other.put('application', webapp));
  const afterRecord = await collector.push();
  await elsewhere(dir.path, (other) => other.forget('job', 'backup'));
  const afterForget = await collector.push();
  collector.close();

  expect(afterRecord[0]?.records).toEqual({
    records: [
      { kind: 'application', name: 'webapp', record: webapp },
      { kind: 'job', name: 'backup', record: cron },
    ],
    unreadable: [],
  });
  expect(afterRecord[0]?.runs).toBeUndefined();
  // Forgetting a job takes its runs with it, so both sections changed.
  expect(afterForget[0]?.records).toEqual({
    records: [{ kind: 'application', name: 'webapp', record: webapp }],
    unreadable: [],
  });
  expect(afterForget[0]?.runs).toEqual({ jobs: [], unreadable: [] });
});

test('a job whose latest run cannot be read travels as unreadable', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('job', cron);
  seed.putRun('backup', minutesAgo(10));
  seed.close();
  const db = new Database(join(dir.path, 'records.sqlite'));
  db.run('UPDATE runs SET body = \'{"surprise":true}\'');
  db.close();
  const collector = await setup(dir);

  const [report] = await collector.push();
  collector.close();

  expect(report?.runs).toEqual({ jobs: [], unreadable: ['backup'] });
});

test('an hour after the last delivered runs, they are sent again though unchanged', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir);
  await collector.push();

  collector.advance(RECORDS_REFRESH_MS - 1);
  const justBefore = await collector.push();
  collector.advance(1);
  const atTheHour = await collector.push();
  const after = await collector.push();
  collector.close();

  expect(justBefore[0]?.runs).toBeUndefined();
  expect(atTheHour[0]?.runs).toEqual({ jobs: [], unreadable: [] });
  expect(after[0]?.runs).toBeUndefined();
});

test('a failed delivery keeps the runs pending for the next Report, as they are then', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('job', cron);
  seed.close();
  const collector = await setup(dir);
  collector.outcomes.push({ kind: 'failed', reason: 'Hub answered 503' });

  const failed = await collector.push();
  const ran = minutesAgo(5);
  await elsewhere(dir.path, (other) => other.putRun('backup', ran));
  const retried = await collector.push();
  const after = await collector.push();
  collector.close();

  expect(failed[0]?.runs).toEqual({ jobs: [], unreadable: [] });
  expect(retried[0]?.runs).toEqual({
    jobs: [{ job: 'backup', latestRun: ran, latestSuccess: ran }],
    unreadable: [],
  });
  expect(after[0]?.runs).toBeUndefined();
});

test('runs over budget travel as their size alone, and are not sent again when they change without changing size', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  const ran = minutesAgo(10);
  seed.put('job', cron);
  seed.putRun('backup', ran);
  seed.close();
  const expected = Buffer.byteLength(
    JSON.stringify({
      jobs: [{ job: 'backup', latestRun: ran, latestSuccess: ran }],
      unreadable: [],
    }),
  );
  const collector = await setup(dir, { maxRunsBytes: expected - 1 });

  const first = await collector.push();
  await elsewhere(dir.path, (other) => other.putRun('backup', minutesAgo(5)));
  const second = await collector.push();
  collector.close();

  expect(first[0]?.runs).toEqual({ overBudget: { bytes: expected } });
  expect(second[0]?.runs).toBeUndefined();
});

test('runs exactly at the budget are sent whole', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir, {
    maxRunsBytes: Buffer.byteLength('{"jobs":[],"unreadable":[]}'),
  });

  const [report] = await collector.push();
  collector.close();

  expect(report?.runs).toEqual({ jobs: [], unreadable: [] });
});

test('a job whose name the section cannot carry is left out of the runs and warned about', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  const ran = minutesAgo(10);
  seed.put('job', cron);
  seed.putRun('backup', ran);
  seed.close();
  const db = new Database(join(dir.path, 'records.sqlite'));
  const insert = db.query(
    'INSERT INTO runs (job, started, startedMs, exitStatus, body) VALUES ($job, $started, $startedMs, 0, $body)',
  );
  const bindings = {
    $body: JSON.stringify(ran),
    $started: ran.started,
    $startedMs: Date.parse(ran.started),
  };
  insert.run({ ...bindings, $job: '../escape' });
  insert.run({ ...bindings, $job: 'has space' });
  db.close();
  const collector = await setup(dir);

  const [report] = await collector.push();
  collector.close();

  expect(RunsSectionSchema.safeParse(report?.runs).success).toBe(true);
  expect(report?.runs).toEqual({
    jobs: [{ job: 'backup', latestRun: ran, latestSuccess: ran }],
    unreadable: [],
  });
  expect(collector.warnings).toHaveLength(1);
  expect(collector.warnings[0]).toContain('../escape');
  expect(collector.warnings[0]).toContain('has space');
});

test('the reporter never reads every run, only the records and the latest runs', async () => {
  await using dir = await tempStateDir();
  const seed = await openRecords({ stateDir: dir.path });
  seed.put('job', cron);
  seed.putRun('backup', minutesAgo(10));
  seed.close();
  const collector = await setup(dir, {
    open: async () => ({
      ...(await openRecords({ stateDir: dir.path })),
      read: () => {
        throw new Error('every run was read');
      },
    }),
  });

  const first = await collector.push();
  await elsewhere(dir.path, (other) => other.putRun('backup', minutesAgo(5)));
  const second = await collector.push();
  collector.close();

  expect(first[0]?.runs).toHaveProperty('jobs');
  expect(second[0]?.runs).toHaveProperty('jobs');
  expect(collector.warnings).toEqual([]);
});

test('runs that cannot be queried cost the sections only, and the Vitals still go', async () => {
  await using dir = await tempStateDir();
  const collector = await setup(dir, {
    open: async () => ({
      ...(await openRecords({ stateDir: dir.path })),
      latestRuns: () => {
        throw new Error('index gone');
      },
    }),
  });

  const [report] = await collector.push();
  collector.close();

  expect(report?.samples).toHaveLength(1);
  expect(report?.runs).toBeUndefined();
  expect(collector.warnings).toHaveLength(1);
  expect(collector.warnings[0]).toContain('index gone');
});
