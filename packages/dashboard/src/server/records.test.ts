import { beforeAll, describe, expect, test } from 'bun:test';

import {
  NOW,
  push,
  report,
  startHub,
  storeReport,
  storeToken,
  unpair,
} from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';
import { RecordsReadSchema } from '@heimdall/schema';
import type {
  JobRecord,
  JobRuns,
  MirroredRecord,
  RunRecord,
  ServiceRecord,
} from '@heimdall/schema';

import { Route } from '../routes/api.v1.records.ts';
import { readFleetOverview } from './fleet-overview.ts';
import { recordsAnswer } from './records.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const YEAR = 365 * 24 * 60 * 60 * 1000;

const WEBAPP: ServiceRecord = { name: 'webapp', supervisor: 'systemd', unit: 'webapp.service' };
const DB: ServiceRecord = { name: 'db', supervisor: 'none' };
const BACKUP: JobRecord = {
  label: 'com.example.backup',
  name: 'backup',
  schedule: [{ hour: 3, minute: 30 }],
  scheduler: 'launchd',
};

const service = (record: ServiceRecord): MirroredRecord => ({
  kind: 'service',
  name: record.name,
  record,
});

// A record set as a Collector sends it.
const set = (records: object[], unreadable: { kind: string; name: string }[] = []) => ({
  records,
  unreadable,
});

// A run that took a minute from `started`, with `exitStatus`.
const run = (started: string, exitStatus = 0): RunRecord => ({
  exitStatus,
  finished: new Date(Date.parse(started) + 60_000).toISOString().replace('.000Z', 'Z'),
  started,
});

const FAILED = run('2026-10-06T03:30:00Z', 1);
const SUCCEEDED = run('2026-10-07T03:30:00Z');

type SentRuns = { job: string; latestRun: object; latestSuccess: object | null };

// A runs section as a Collector sends it.
const runs = (jobs: SentRuns[], unreadable: string[] = []) => ({ jobs, unreadable });

// A job that has only failed, and one whose latest run succeeded.
const failing = (job: string): JobRuns => ({ job, latestRun: FAILED, latestSuccess: null });
const passing = (job: string): JobRuns => ({
  job,
  latestRun: SUCCEEDED,
  latestSuccess: SUCCEEDED,
});

// The jobs of an entry's runs, when it holds runs that fit.
const jobsOf = (entry: Awaited<ReturnType<typeof entryOf>>) =>
  entry?.runs && 'jobs' in entry.runs ? entry.runs.jobs : undefined;

// Sends `laptop-1`'s Report at `sentAt` (epoch milliseconds), with `records`,
// `runs`, and `timeZone` unless they are undefined. Each Report carries a
// sample no earlier one has.
let sampleTime = NOW;
const send = async (
  h: Hub,
  {
    checks,
    records,
    runs: sentRuns,
    sentAt = NOW,
    system = 'laptop-1',
    timeZone,
  }: {
    checks?: unknown;
    records?: unknown;
    runs?: unknown;
    sentAt?: number;
    system?: string;
    timeZone?: string;
  },
) => {
  sampleTime += 15_000;
  const token = system === 'laptop-1' ? 'laptop-token' : 'server-token';
  const response = await push(
    h.hub,
    {
      ...report(system, [sampleTime]),
      sentAt,
      ...(checks === undefined ? {} : { checks }),
      ...(records === undefined ? {} : { records }),
      ...(sentRuns === undefined ? {} : { runs: sentRuns }),
      ...(timeZone === undefined ? {} : { timeZone }),
    },
    { token },
  );
  expect(response.status).toBe(200);
};

// `GET /api/v1/records` over the test Hub's database.
const ask = (h: Hub, query = '', onError: (error: unknown) => void = () => undefined) =>
  recordsAnswer({
    database: () => Promise.resolve(h.db.sql),
    onError,
    url: new URL(`http://dashboard.test/api/v1/records${query}`),
  });

// The answer of `GET /api/v1/records`, checked against the published schema.
const read = async (h: Hub, query = '') => {
  const response = await ask(h, query);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('application/json');
  return RecordsReadSchema.parse(await response.json()).systems;
};

const entryOf = async (h: Hub, system = 'laptop-1') =>
  (await read(h)).find((entry) => entry.system === system);

describe('the records a Report carries', () => {
  test('are read back with the time they were sent and received', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2500;

    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    expect(await entryOf(h)).toEqual({
      checks: null,
      paired: true,
      receivedAt: new Date(NOW + 2500).toISOString(),
      records: [service(WEBAPP)],
      runs: null,
      sentAt: new Date(NOW + 1000).toISOString(),
      system: 'laptop-1',
      timeZone: null,
      unreadable: [],
    });
  });

  test('replace the earlier set, so a forgotten record is gone', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP), service(DB)]) });

    await send(h, { records: set([service(DB)]), sentAt: NOW + 1000 });

    expect(await entryOf(h)).toMatchObject({ records: [service(DB)] });
  });

  test('come back sorted by kind, then name', async () => {
    await using h = await startHub();

    await send(h, {
      records: set([service(WEBAPP), { kind: 'job', name: 'backup', record: BACKUP }, service(DB)]),
    });

    const entry = await entryOf(h);
    expect(entry && 'records' in entry && entry.records?.map((r) => `${r.kind}/${r.name}`)).toEqual(
      ['job/backup', 'service/db', 'service/webapp'],
    );
  });

  test('may be empty, which reads as a System that holds none', async () => {
    await using h = await startHub();

    await send(h, { records: set([]) });

    expect(await entryOf(h)).toMatchObject({ records: [], unreadable: [] });
  });

  test('are left as they were by a Report without a set', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });

    await send(h, { sentAt: NOW + 60_000 });

    expect(await entryOf(h)).toMatchObject({
      records: [service(WEBAPP)],
      sentAt: new Date(NOW).toISOString(),
    });
  });

  test('keep the newest set: an earlier one is ignored, a same-moment or post-bad-clock one replaces it', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2000;
    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    await send(h, { records: set([service(DB)]), sentAt: NOW });
    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)] });

    await send(h, { records: set([service(DB)]), sentAt: NOW + 1000 });
    expect(await entryOf(h)).toMatchObject({ records: [service(DB)] });

    // A set that claims a time in the Hub future does not freeze the next one.
    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 10 * YEAR });
    h.clock.now = NOW + 60_000;
    await send(h, { records: set([service(DB)]), sentAt: NOW + 60_000 });
    expect(await entryOf(h)).toMatchObject({
      records: [service(DB)],
      sentAt: new Date(NOW + 60_000).toISOString(),
    });
  });

  test('keep each System to its own set', async () => {
    await using h = await startHub();

    await send(h, { records: set([service(WEBAPP)]) });
    await send(h, { records: set([service(DB)]), system: 'server-1' });

    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)] });
    expect(await entryOf(h, 'server-1')).toMatchObject({ records: [service(DB)] });
  });

  test('lose a field the Hub does not know', async () => {
    await using h = await startHub();

    await send(h, {
      records: set([{ ...service(WEBAPP), record: { ...WEBAPP, newerField: 'x' } }]),
    });

    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)], unreadable: [] });
  });

  test('count a record of a kind the Hub does not know as unreadable', async () => {
    await using h = await startHub();

    await send(h, {
      records: set([service(WEBAPP), { kind: 'secret', name: 'vault', record: { name: 'vault' } }]),
    });

    expect(await entryOf(h)).toMatchObject({
      records: [service(WEBAPP)],
      unreadable: [{ kind: 'secret', name: 'vault' }],
    });
  });

  test('list the records the Collector could not read itself', async () => {
    await using h = await startHub();

    await send(h, { records: set([service(WEBAPP)], [{ kind: 'job', name: 'backup' }]) });

    expect(await entryOf(h)).toMatchObject({ unreadable: [{ kind: 'job', name: 'backup' }] });
  });

  test('keep the kind of an unreadable record as text PostgreSQL can store', async () => {
    await using h = await startHub();

    await send(h, {
      records: set([{ kind: 'se\0cret', name: 'vault', record: { name: 'vault' } }]),
    });

    expect(await entryOf(h)).toMatchObject({
      records: [],
      unreadable: [{ kind: 'se\uFFFDcret', name: 'vault' }],
    });
  });
});

describe('a set over budget', () => {
  test('reads as unavailable and drops the earlier records', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });

    await send(h, { records: { overBudget: { bytes: 9_000_000 } }, sentAt: NOW + 1000 });

    expect(await entryOf(h)).toEqual({
      checks: null,
      overBudget: { bytes: 9_000_000 },
      paired: true,
      receivedAt: new Date(NOW).toISOString(),
      runs: null,
      sentAt: new Date(NOW + 1000).toISOString(),
      system: 'laptop-1',
      timeZone: null,
    });
  });

  test('gives way to the next set that fits', async () => {
    await using h = await startHub();
    await send(h, { records: { overBudget: { bytes: 9_000_000 } } });

    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)] });
  });
});

describe('the latest runs a Report carries', () => {
  test('are read back with the time they were sent and received', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2500;

    await send(h, { runs: runs([passing('backup')]), sentAt: NOW + 1000 });

    expect((await entryOf(h))?.runs).toEqual({
      jobs: [passing('backup')],
      receivedAt: new Date(NOW + 2500).toISOString(),
      sentAt: new Date(NOW + 1000).toISOString(),
      unreadable: [],
    });
  });

  test('keep the success a later failure follows as the latest success', async () => {
    await using h = await startHub();

    await send(h, {
      runs: runs([{ job: 'backup', latestRun: FAILED, latestSuccess: SUCCEEDED }]),
    });

    expect(jobsOf(await entryOf(h))).toEqual([
      { job: 'backup', latestRun: FAILED, latestSuccess: SUCCEEDED },
    ]);
  });

  test('read a job that has never succeeded as having no latest success', async () => {
    await using h = await startHub();

    await send(h, { runs: runs([failing('backup')]) });

    expect(jobsOf(await entryOf(h))?.[0]?.latestSuccess).toBeNull();
  });

  test('replace the earlier runs, so a job a later section lacks is gone', async () => {
    await using h = await startHub();
    await send(h, { runs: runs([passing('backup'), failing('prune')]) });

    await send(h, { runs: runs([failing('prune')]), sentAt: NOW + 1000 });

    expect(jobsOf(await entryOf(h))?.map((j) => j.job)).toEqual(['prune']);
  });

  test('may be empty, which reads as a System whose jobs have not run', async () => {
    await using h = await startHub();

    await send(h, { runs: runs([]) });

    expect(await entryOf(h)).toMatchObject({ runs: { jobs: [], unreadable: [] } });
  });

  test('come back sorted by job name, whatever the collation', async () => {
    await using h = await startHub();

    await send(h, { runs: runs(['b', 'a-c', 'B', 'ab', 'a_b'].map(failing)) });

    expect(jobsOf(await entryOf(h))?.map((j) => j.job)).toEqual(['B', 'a-c', 'a_b', 'ab', 'b']);
  });

  test('keep the newest runs: earlier ones are ignored, same-moment or post-bad-clock ones replace them', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2000;
    await send(h, { runs: runs([passing('backup')]), sentAt: NOW + 1000 });

    await send(h, { runs: runs([failing('prune')]), sentAt: NOW });
    expect(await entryOf(h)).toMatchObject({
      runs: { jobs: [passing('backup')], sentAt: new Date(NOW + 1000).toISOString() },
    });

    await send(h, { runs: runs([failing('prune')]), sentAt: NOW + 1000 });
    expect(jobsOf(await entryOf(h))?.map((j) => j.job)).toEqual(['prune']);

    // Runs that claim a time in the Hub future do not freeze the next ones.
    await send(h, { runs: runs([passing('backup')]), sentAt: NOW + 10 * YEAR });
    h.clock.now = NOW + 60_000;
    await send(h, { runs: runs([failing('prune')]), sentAt: NOW + 60_000 });
    expect(await entryOf(h)).toMatchObject({
      runs: { jobs: [failing('prune')], sentAt: new Date(NOW + 60_000).toISOString() },
    });
  });

  test('are left as they were by a Report without a runs section', async () => {
    await using h = await startHub();
    await send(h, { runs: runs([failing('backup')]) });

    await send(h, { sentAt: NOW + 60_000 });

    expect(await entryOf(h)).toMatchObject({
      runs: { jobs: [failing('backup')], sentAt: new Date(NOW).toISOString() },
    });
  });

  test('keep each System to its own runs', async () => {
    await using h = await startHub();

    await send(h, { runs: runs([failing('backup')]) });
    await send(h, { runs: runs([failing('prune')]), system: 'server-1' });

    expect(jobsOf(await entryOf(h))?.map((j) => j.job)).toEqual(['backup']);
    expect(jobsOf(await entryOf(h, 'server-1'))?.map((j) => j.job)).toEqual(['prune']);
  });

  test('lose a field the Hub does not know', async () => {
    await using h = await startHub();

    await send(h, {
      runs: runs([
        {
          job: 'backup',
          latestRun: { ...SUCCEEDED, newerField: 'x' },
          latestSuccess: { ...SUCCEEDED, newerField: 'x' },
        },
      ]),
    });

    expect(jobsOf(await entryOf(h))).toEqual([passing('backup')]);
  });

  test('count a job whose runs the Hub cannot read as unreadable', async () => {
    await using h = await startHub();

    await send(h, {
      runs: runs([
        passing('backup'),
        { job: 'prune', latestRun: { exitStatus: 'unknown' }, latestSuccess: null },
      ]),
    });

    expect(await entryOf(h)).toMatchObject({
      runs: { jobs: [passing('backup')], unreadable: ['prune'] },
    });
  });

  test('list the jobs the Collector could not read itself', async () => {
    await using h = await startHub();

    await send(h, { runs: runs([passing('backup')], ['prune']) });

    expect(await entryOf(h)).toMatchObject({
      runs: { jobs: [passing('backup')], unreadable: ['prune'] },
    });
  });
});

describe('runs over budget', () => {
  test('read as unavailable and drop the earlier jobs', async () => {
    await using h = await startHub();
    await send(h, { runs: runs([failing('backup')]) });

    await send(h, { runs: { overBudget: { bytes: 3_000_000 } }, sentAt: NOW + 1000 });

    expect((await entryOf(h))?.runs).toEqual({
      overBudget: { bytes: 3_000_000 },
      receivedAt: new Date(NOW).toISOString(),
      sentAt: new Date(NOW + 1000).toISOString(),
    });
  });

  test('give way to the next runs that fit', async () => {
    await using h = await startHub();
    await send(h, { runs: { overBudget: { bytes: 3_000_000 } } });

    await send(h, { runs: runs([failing('backup')]), sentAt: NOW + 1000 });

    expect(jobsOf(await entryOf(h))).toEqual([failing('backup')]);
  });
});

describe('the time zone a Report carries', () => {
  test('the time zone is set, kept by a Report without one or with one the Hub cannot read, and changed by another', async () => {
    await using h = await startHub();

    await send(h, { timeZone: 'America/New_York' });
    expect(await entryOf(h)).toMatchObject({ timeZone: 'America/New_York' });

    await send(h, { sentAt: NOW + 60_000 });
    expect(await entryOf(h)).toMatchObject({ timeZone: 'America/New_York' });

    await send(h, { sentAt: NOW + 120_000, timeZone: 'America/New York' });
    expect(await entryOf(h)).toMatchObject({ timeZone: 'America/New_York' });

    await send(h, { sentAt: NOW + 180_000, timeZone: 'Europe/Berlin' });
    expect(await entryOf(h)).toMatchObject({ timeZone: 'Europe/Berlin' });
  });
});

describe('records and runs', () => {
  test('are each held against their own sent time', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2000;
    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    await send(h, { runs: runs([failing('backup')]), sentAt: NOW });

    expect(await entryOf(h)).toMatchObject({
      records: [service(WEBAPP)],
      runs: { jobs: [failing('backup')] },
    });
  });
});

const CONF = {
  path: '/etc/webapp/webapp.conf',
  record: 'webapp-config',
  state: 'drifted',
} as const;
const DIR = { path: '/etc/webapp', record: 'webapp-config', state: 'unreadable' } as const;

// A file check as a Collector sends it, since `since` (epoch milliseconds).
const sentCheck = (
  file: { path: string; record: string; state: string },
  since = NOW - 60_000,
) => ({ ...file, since });

const WEB = {
  check: 'supervisor',
  detail: 'ActiveState=active',
  service: 'web',
  state: 'up',
} as const;

// A Service check as a Collector sends it, since `since` (epoch milliseconds).
const sentService = (
  check: { check: string; detail: string; service: string; state: string },
  since = NOW - 60_000,
) => ({ ...check, since });

describe('the checks a Report carries', () => {
  test('read a Docker image back through the Hub mirror and the published read schema', async () => {
    await using h = await startHub();
    const check = { ...WEB, detail: 'status running', image: 'registry.example/web:1.2.3' };
    const record: ServiceRecord = {
      application: 'web-software',
      container: 'web',
      name: 'web',
      supervisor: 'docker',
    };

    await send(h, { checks: { services: [sentService(check)] }, records: set([service(record)]) });

    expect(await entryOf(h)).toMatchObject({
      checks: { services: [{ ...check, since: new Date(NOW - 60_000).toISOString() }] },
      records: [service(record)],
    });
  });

  test('are read back with the time each file was first seen, sorted by record and path', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2500;

    await send(h, {
      checks: { files: [sentCheck(CONF), sentCheck(DIR), sentCheck({ ...CONF, record: 'a' })] },
      sentAt: NOW + 1000,
    });

    expect((await entryOf(h))?.checks).toEqual({
      fileRecords: [],
      files: [
        { ...CONF, record: 'a', since: new Date(NOW - 60_000).toISOString() },
        { ...DIR, since: new Date(NOW - 60_000).toISOString() },
        { ...CONF, since: new Date(NOW - 60_000).toISOString() },
      ],
      receivedAt: new Date(NOW + 2500).toISOString(),
      sentAt: new Date(NOW + 1000).toISOString(),
    });
  });

  test('are read back with the digest of each files record they judged, sorted by record', async () => {
    await using h = await startHub();

    await send(h, {
      checks: {
        fileRecords: [
          { digest: 'b'.repeat(64), record: 'b' },
          { digest: 'c'.repeat(64), record: 'B' },
          { digest: 'a'.repeat(64), record: 'a' },
        ],
        files: [],
      },
    });

    expect((await entryOf(h))?.checks).toMatchObject({
      fileRecords: [
        { digest: 'c'.repeat(64), record: 'B' },
        { digest: 'a'.repeat(64), record: 'a' },
        { digest: 'b'.repeat(64), record: 'b' },
      ],
    });
  });

  test('sort by code unit, as records and runs do, not by locale', async () => {
    await using h = await startHub();

    await send(h, {
      checks: {
        files: [
          sentCheck({ ...CONF, path: '/a', record: 'b' }),
          sentCheck({ ...CONF, path: '/b', record: 'B' }),
          sentCheck({ ...CONF, path: '/a', record: 'B' }),
        ],
      },
    });

    const checks = (await entryOf(h))?.checks;
    expect(checks?.files?.map((f) => [f.record, f.path])).toEqual([
      ['B', '/a'],
      ['B', '/b'],
      ['b', '/a'],
    ]);
  });

  test('replace the earlier checks, an older Report does not replace newer ones, and a same-moment or post-bad-clock set does', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 5000;
    await send(h, { checks: { files: [sentCheck(CONF)] }, sentAt: NOW + 1000 });
    await send(h, { checks: { files: [] }, sentAt: NOW });

    const kept = (await entryOf(h))?.checks;
    await send(h, { checks: { files: [] }, sentAt: NOW + 2000 });

    expect(kept).toMatchObject({ files: [{ path: CONF.path }] });
    expect((await entryOf(h))?.checks).toMatchObject({ files: [] });

    // Checks sent at the very same time replace the held ones.
    await send(h, { checks: { files: [sentCheck(CONF)] }, sentAt: NOW + 2000 });
    expect((await entryOf(h))?.checks).toMatchObject({ files: [{ path: CONF.path }] });

    // Held checks that claim a time after the Hub clock give way to the next.
    await send(h, { checks: { files: [sentCheck(CONF)] }, sentAt: NOW + 10 * YEAR });
    await send(h, { checks: { files: [] }, sentAt: NOW + 60_000 });
    expect((await entryOf(h))?.checks).toMatchObject({
      files: [],
      sentAt: new Date(NOW + 60_000).toISOString(),
    });
  });

  test('are kept by a Report that carries none', async () => {
    await using h = await startHub();
    await send(h, { checks: { files: [sentCheck(CONF)] } });

    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    expect((await entryOf(h))?.checks).toMatchObject({ files: [{ path: CONF.path }] });
  });

  test('read as the size of a files part too large to send, and drop the earlier files', async () => {
    await using h = await startHub();
    await send(h, { checks: { files: [sentCheck(CONF)] } });

    await send(h, {
      checks: { overBudget: { files: { bytes: 2_000_000 } } },
      sentAt: NOW + 1000,
    });

    expect((await entryOf(h))?.checks).toEqual({
      overBudget: { files: { bytes: 2_000_000 } },
      receivedAt: new Date(NOW).toISOString(),
      sentAt: new Date(NOW + 1000).toISOString(),
    });
  });

  test('read with the services beside a files part too large to send', async () => {
    await using h = await startHub();

    await send(h, {
      checks: { overBudget: { files: { bytes: 2_000_000 } }, services: [sentService(WEB)] },
    });

    expect((await entryOf(h))?.checks).toEqual({
      overBudget: { files: { bytes: 2_000_000 } },
      receivedAt: new Date(NOW).toISOString(),
      sentAt: new Date(NOW).toISOString(),
      services: [{ ...WEB, since: new Date(NOW - 60_000).toISOString() }],
    });
  });

  test('read with the size of a services part too large to send, and no services', async () => {
    await using h = await startHub();
    await send(h, { checks: { services: [sentService(WEB)] } });

    await send(h, {
      checks: { files: [], overBudget: { services: { bytes: 2_000_000 } } },
      sentAt: NOW + 1000,
    });

    expect((await entryOf(h))?.checks).toEqual({
      fileRecords: [],
      files: [],
      overBudget: { services: { bytes: 2_000_000 } },
      receivedAt: new Date(NOW).toISOString(),
      sentAt: new Date(NOW + 1000).toISOString(),
    });
  });

  test('read without files or hashed records when the section carries no files part, and with them empty when it carries an empty one', async () => {
    await using h = await startHub();
    await send(h, { checks: { fileRecords: [{ digest: 'a'.repeat(64), record: 'a' }] } });
    const absent = (await entryOf(h))?.checks;

    await send(h, { checks: { files: [] }, sentAt: NOW + 1000 });
    const empty = (await entryOf(h))?.checks;

    expect(absent).toEqual({
      receivedAt: new Date(NOW).toISOString(),
      sentAt: new Date(NOW).toISOString(),
    });
    expect(empty).toMatchObject({ fileRecords: [], files: [] });
  });

  test('read with each Service check, sorted by service, and without services when none were sent', async () => {
    await using h = await startHub();
    await send(h, { checks: { files: [] } });
    const without = (await entryOf(h))?.checks;

    await send(h, {
      checks: {
        services: [
          sentService({ ...WEB, service: 'web' }),
          sentService({ ...WEB, detail: 'ActiveState=failed', service: 'Db', state: 'stopped' }),
        ],
      },
      sentAt: NOW + 1000,
    });

    expect(without).not.toHaveProperty('services');
    expect((await entryOf(h))?.checks).toMatchObject({
      services: [
        {
          check: 'supervisor',
          detail: 'ActiveState=failed',
          service: 'Db',
          since: new Date(NOW - 60_000).toISOString(),
          state: 'stopped',
        },
        { service: 'web', state: 'up' },
      ],
    });
  });

  test('read with a health check beside the supervisor check of the same Service', async () => {
    await using h = await startHub();

    await send(h, {
      checks: {
        services: [
          sentService({ check: 'health', detail: 'HTTP 503', service: 'web', state: 'unhealthy' }),
          sentService(WEB),
        ],
      },
    });

    expect((await entryOf(h))?.checks).toMatchObject({
      services: [
        { check: 'health', detail: 'HTTP 503', service: 'web', state: 'unhealthy' },
        { check: 'supervisor', service: 'web', state: 'up' },
      ],
    });
  });

  test('read as an empty list when the Collector has no Service to check', async () => {
    await using h = await startHub();

    await send(h, { checks: { services: [] } });

    expect((await entryOf(h))?.checks).toMatchObject({ services: [] });
  });
});

describe('reading the records', () => {
  test('answers null for a System no Report has carried a set for', async () => {
    await using h = await startHub();
    await send(h, {});

    expect(await read(h)).toEqual([
      { checks: null, paired: true, records: null, runs: null, system: 'laptop-1', timeZone: null },
    ]);
  });

  test('lists Systems in the order the fleet overview does, whatever the collation', async () => {
    await using h = await startHub();
    // Every paired System reports, since the overview also lists one that never has.
    await send(h, {});
    await send(h, { system: 'server-1' });
    await Promise.all(
      ['a-c', 'ab', 'a-b', 'B', 'a_b'].map(async (system) => {
        await storeReport(h.db.sql, { receivedAt: NOW, report: report(system, [NOW]) });
        await storeToken(h.db.sql, { pairedAt: NOW, system, token: `${system}-token` });
      }),
    );

    const { lanes } = await readFleetOverview(h.db.sql, {
      now: NOW,
      range: '24h',
    });
    expect((await read(h)).map((entry) => entry.system)).toEqual(lanes.map((lane) => lane.name));
  });

  test('answers an empty list when no System has reported', async () => {
    await using h = await startHub();

    expect(await read(h)).toEqual([]);
  });

  test("the route hands its request's query to the answer", async () => {
    const get = Route.options.server?.handlers;
    const handler = typeof get === 'object' ? get.GET : undefined;
    const request = new Request('http://dashboard.test/api/v1/records?unpaired=INCLUDE');

    // The 400 comes before the database is opened, so none is needed.
    const response = await (handler as (ctx: { request: Request }) => Promise<Response>)({
      request,
    });

    expect(response.status).toBe(400);
  });

  test('answers 503 when the database cannot be opened, and reports why', async () => {
    const errors: unknown[] = [];
    const response = await recordsAnswer({
      database: () => Promise.reject(new Error('No database URL')),
      onError: (error) => errors.push(error),
      url: new URL('http://dashboard.test/api/v1/records'),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toBe('The dashboard cannot answer right now; try again later.');
    expect(errors).toEqual([new Error('No database URL')]);
  });

  test('answers 503 when the database cannot answer', async () => {
    const h = await startHub();
    await h.db.sql.close();

    const errors: unknown[] = [];

    const response = await ask(h, '', (error) => errors.push(error));

    expect(response.status).toBe(503);
    expect(errors).toHaveLength(1);
    await h.db[Symbol.asyncDispose]().catch(() => undefined);
  });
});

// Both paired Systems report; then `laptop-1` is unpaired.
const unpairedLaptop = async (h: Hub) => {
  await push(h.hub, report('server-1', [NOW]), { token: 'server-token' });
  await push(h.hub, report('laptop-1', [NOW]), { token: 'laptop-token' });
  await unpair(h.db.sql, 'laptop-1');
};

describe('the paired and unpaired Systems', () => {
  test('the records read leaves unpaired Systems out, marks the rest paired, and includes them on request', async () => {
    await using h = await startHub();
    await unpairedLaptop(h);

    const normal = await read(h);
    expect(normal.map((s) => [s.system, s.paired])).toEqual([['server-1', true]]);

    const included = await read(h, '?unpaired=include');
    expect(included.map((s) => [s.system, s.paired])).toEqual([
      ['laptop-1', false],
      ['server-1', true],
    ]);
  });

  test('a records read that repeats include still includes unpaired Systems', async () => {
    await using h = await startHub();
    await unpairedLaptop(h);

    const included = await read(h, '?unpaired=include&unpaired=include');

    expect(included.map((s) => s.system)).toEqual(['laptop-1', 'server-1']);
  });
});
