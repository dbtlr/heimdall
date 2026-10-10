import { describe, expect, test } from 'bun:test';

import { MAX_REPORT_BYTES, RecordsReadSchema } from '@heimdall/schema';
import type {
  JobRecord,
  JobRuns,
  MirroredRecord,
  RunRecord,
  ServiceRecord,
} from '@heimdall/schema';

import { migrate, MIGRATIONS } from './migrations.ts';
import { listSystems, storeReport } from './store.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';

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
    records,
    runs: sentRuns,
    sentAt = NOW,
    system = 'laptop-1',
    timeZone,
  }: { records?: unknown; runs?: unknown; sentAt?: number; system?: string; timeZone?: string },
) => {
  sampleTime += 15_000;
  const token = system === 'laptop-1' ? 'laptop-token' : 'server-token';
  const response = await push(
    h.hub,
    {
      ...report(system, [sampleTime]),
      sentAt,
      ...(records === undefined ? {} : { records }),
      ...(sentRuns === undefined ? {} : { runs: sentRuns }),
      ...(timeZone === undefined ? {} : { timeZone }),
    },
    { token },
  );
  expect(response.status).toBe(200);
};

// `GET /api/v1/records`, checked against the published schema.
const read = async (h: Hub) => {
  const response = await h.hub.fetch(new Request('http://hub.test/api/v1/records'));
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

  test('are ignored when the Hub holds a set sent later', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2000;
    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    await send(h, { records: set([service(DB)]), sentAt: NOW });

    expect(await entryOf(h)).toMatchObject({ records: [service(WEBAPP)] });
  });

  test('replace a set that claims a time in the Hub future, so a bad clock cannot freeze them', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 10 * YEAR });
    h.clock.now = NOW + 60_000;

    await send(h, { records: set([service(DB)]), sentAt: NOW + 60_000 });

    expect(await entryOf(h)).toMatchObject({
      records: [service(DB)],
      sentAt: new Date(NOW + 60_000).toISOString(),
    });
  });

  test('replace a set sent at the same moment', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });

    await send(h, { records: set([service(DB)]) });

    expect(await entryOf(h)).toMatchObject({ records: [service(DB)] });
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
      overBudget: { bytes: 9_000_000 },
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

  test('does not replace a set sent later', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2000;
    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    await send(h, { records: { overBudget: { bytes: 9_000_000 } }, sentAt: NOW });

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

  test('read a failed run, then a later success, as the latest run and latest success', async () => {
    await using h = await startHub();
    await send(h, { runs: runs([failing('backup')]) });
    expect(jobsOf(await entryOf(h))).toEqual([failing('backup')]);

    await send(h, { runs: runs([passing('backup')]), sentAt: NOW + 1000 });

    expect(jobsOf(await entryOf(h))).toEqual([
      { job: 'backup', latestRun: SUCCEEDED, latestSuccess: SUCCEEDED },
    ]);
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

  test('are ignored when the Hub holds runs sent later', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2000;
    await send(h, { runs: runs([passing('backup')]), sentAt: NOW + 1000 });

    await send(h, { runs: runs([failing('prune')]), sentAt: NOW });

    expect(await entryOf(h)).toMatchObject({
      runs: { jobs: [passing('backup')], sentAt: new Date(NOW + 1000).toISOString() },
    });
  });

  test('replace runs that claim a time in the Hub future, so a bad clock cannot freeze them', async () => {
    await using h = await startHub();
    await send(h, { runs: runs([passing('backup')]), sentAt: NOW + 10 * YEAR });
    h.clock.now = NOW + 60_000;

    await send(h, { runs: runs([failing('prune')]), sentAt: NOW + 60_000 });

    expect(await entryOf(h)).toMatchObject({
      runs: { jobs: [failing('prune')], sentAt: new Date(NOW + 60_000).toISOString() },
    });
  });

  test('replace runs sent at the same moment', async () => {
    await using h = await startHub();
    await send(h, { runs: runs([failing('backup')]) });

    await send(h, { runs: runs([failing('prune')]) });

    expect(jobsOf(await entryOf(h))?.map((j) => j.job)).toEqual(['prune']);
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

  test('do not replace runs sent later', async () => {
    await using h = await startHub();
    h.clock.now = NOW + 2000;
    await send(h, { runs: runs([failing('backup')]), sentAt: NOW + 1000 });

    await send(h, { runs: { overBudget: { bytes: 3_000_000 } }, sentAt: NOW });

    expect(jobsOf(await entryOf(h))).toEqual([failing('backup')]);
  });
});

describe('the time zone a Report carries', () => {
  test('is read back', async () => {
    await using h = await startHub();

    await send(h, { timeZone: 'America/New_York' });

    expect(await entryOf(h)).toMatchObject({ timeZone: 'America/New_York' });
  });

  test('is kept by a Report without one', async () => {
    await using h = await startHub();
    await send(h, { timeZone: 'America/New_York' });

    await send(h, { sentAt: NOW + 60_000 });

    expect(await entryOf(h)).toMatchObject({ timeZone: 'America/New_York' });
  });

  test('is changed by a Report with another', async () => {
    await using h = await startHub();
    await send(h, { timeZone: 'America/New_York' });

    await send(h, { timeZone: 'Europe/Berlin' });

    expect(await entryOf(h)).toMatchObject({ timeZone: 'Europe/Berlin' });
  });

  test('that the Hub cannot read costs no Report, and the Hub keeps the zone it holds', async () => {
    await using h = await startHub();
    await send(h, { timeZone: 'America/New_York' });

    await send(h, { sentAt: NOW + 60_000, timeZone: 'America/New York' });

    expect(await entryOf(h)).toMatchObject({ timeZone: 'America/New_York' });
  });
});

describe('records and runs', () => {
  test('arrive independently: runs leave the records as they were', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });

    await send(h, { runs: runs([failing('backup')]), sentAt: NOW + 1000 });

    expect(await entryOf(h)).toMatchObject({
      records: [service(WEBAPP)],
      runs: { jobs: [failing('backup')] },
      sentAt: new Date(NOW).toISOString(),
    });
  });

  test('arrive independently: records leave the runs as they were', async () => {
    await using h = await startHub();
    await send(h, { runs: runs([failing('backup')]) });

    await send(h, { records: set([service(WEBAPP)]), sentAt: NOW + 1000 });

    expect(await entryOf(h)).toMatchObject({
      records: [service(WEBAPP)],
      runs: { jobs: [failing('backup')], sentAt: new Date(NOW).toISOString() },
    });
  });

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

describe('reading the records', () => {
  test('answers null for a System no Report has carried a set for', async () => {
    await using h = await startHub();
    await send(h, {});

    expect(await read(h)).toEqual([
      { records: null, runs: null, system: 'laptop-1', timeZone: null },
    ]);
  });

  test('answers null runs and time zone for a System that never sent them', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });

    expect(await entryOf(h)).toMatchObject({ runs: null, timeZone: null });
  });

  test('lists Systems by name, as the dashboard does', async () => {
    await using h = await startHub();
    await send(h, { records: set([service(WEBAPP)]) });
    await send(h, { system: 'server-1' });

    expect((await read(h)).map((entry) => entry.system)).toEqual(['laptop-1', 'server-1']);
  });

  test('lists Systems in the order the dashboard does, whatever the collation', async () => {
    await using h = await startHub();
    await Promise.all(
      ['a-c', 'ab', 'a-b', 'B', 'a_b'].map((system) =>
        storeReport(h.db.sql, { receivedAt: NOW, report: report(system, [NOW]) }),
      ),
    );

    expect((await read(h)).map((entry) => entry.system)).toEqual(
      (await listSystems(h.db.sql)).map((system) => system.name),
    );
  });

  test('answers an empty list when no System has reported', async () => {
    await using h = await startHub();

    expect(await read(h)).toEqual([]);
  });

  test('is open without a token, and answers no other method', async () => {
    await using h = await startHub();

    const post = await h.hub.fetch(
      new Request('http://hub.test/api/v1/records', { body: '{}', method: 'POST' }),
    );

    expect(post.status).toBe(404);
  });

  test('answers 503 when the database cannot answer', async () => {
    const h = await startHub();
    await h.db.sql.close();

    const response = await h.hub.fetch(new Request('http://hub.test/api/v1/records'));

    expect(response.status).toBe(503);
    expect(h.errors).toHaveLength(1);
    await h.db[Symbol.asyncDispose]().catch(() => undefined);
  });
});

test('a Report just over the old 4 MiB cap is accepted', async () => {
  await using h = await startHub();
  const filler = 'x'.repeat(256);
  const records = set(
    Array.from({ length: 12_000 }, (_, i) =>
      service({ ...WEBAPP, name: `svc-${String(i)}`, unit: `${filler}${String(i)}` }),
    ),
  );
  const body = JSON.stringify({ ...report('laptop-1', [NOW]), records });
  expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
  expect(body.length).toBeLessThan(MAX_REPORT_BYTES);

  const response = await push(h.hub, body, { token: 'laptop-token' });

  expect(response.status).toBe(200);
});

test('migration 7 applies on top of version 6 and keeps what was there', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 6),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;

  expect(
    await migrate(
      db.sql,
      MIGRATIONS.filter((m) => m.version <= 7),
    ),
  ).toEqual([7]);

  const rows = await db.sql`SELECT name FROM systems`;
  expect(rows).toHaveLength(1);
});

test('migration 8 applies on top of version 7 and leaves a System with no time zone or runs', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 7),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;

  expect(
    await migrate(
      db.sql,
      MIGRATIONS.filter((m) => m.version <= 8),
    ),
  ).toEqual([8]);

  const rows = await db.sql`
    SELECT s.name, s.time_zone, r.system AS runs_system
    FROM systems s LEFT JOIN run_sets r ON r.system = s.name
  `;
  expect(rows).toEqual([{ name: 'laptop-1', runs_system: null, time_zone: null }]);
});
