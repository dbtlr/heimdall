import { expect, test } from 'bun:test';

import type { SentJobRun } from '@heimdall/schema';

import { pruneJobRuns } from './retention.ts';
import { storeReport } from './store.ts';
import { NOW, push, report, startHub } from './testing/hub.ts';
import { plainRows } from './testing/postgres.ts';

const DAY = 86_400_000;

const whole = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

const jobRun = (startedAt: number, extra: Partial<SentJobRun> = {}): SentJobRun => ({
  exitStatus: 0,
  finished: whole(startedAt + 5000),
  job: 'backup',
  started: whole(startedAt),
  ...extra,
});

const MINUTE = 60_000;

const send = (
  h: Awaited<ReturnType<typeof startHub>>,
  runs: SentJobRun[],
  {
    sentAt = NOW,
    receivedAt = sentAt,
    system = 'laptop-1',
  }: { receivedAt?: number; sentAt?: number; system?: string } = {},
) =>
  storeReport(h.db.sql, {
    onWarn: (message) => h.warnings.push(message),
    receivedAt,
    report: { ...report(system, []), jobRuns: { runs }, sentAt },
  });

const stored = (h: Awaited<ReturnType<typeof startHub>>) =>
  plainRows(
    h.db.sql<Record<string, unknown>[]>`
      SELECT system, job, started_at, finished_at, exit_status, output_file, output_size_bytes, sent_at, received_at
      FROM job_runs ORDER BY system, job, started_at
    `,
  );

test('a Report stores its job runs with the output and the sent and received times', async () => {
  await using h = await startHub();
  const started = NOW - 3600_000;
  await storeReport(h.db.sql, {
    onWarn: (message) => h.warnings.push(message),
    receivedAt: NOW + 1000,
    report: {
      ...report('laptop-1', []),
      jobRuns: {
        runs: [
          jobRun(started, { exitStatus: 3, output: { file: 'backup.log', sizeBytes: 2048 } }),
          jobRun(started + 60_000),
        ],
      },
    },
  });

  expect(await stored(h)).toEqual([
    {
      exit_status: 3,
      finished_at: new Date(started + 5000),
      job: 'backup',
      output_file: 'backup.log',
      output_size_bytes: '2048',
      received_at: new Date(NOW + 1000),
      sent_at: new Date(NOW),
      started_at: new Date(started),
      system: 'laptop-1',
    },
    {
      exit_status: 0,
      finished_at: new Date(started + 65_000),
      job: 'backup',
      output_file: null,
      output_size_bytes: null,
      received_at: new Date(NOW + 1000),
      sent_at: new Date(NOW),
      started_at: new Date(started + 60_000),
      system: 'laptop-1',
    },
  ]);
});

test('a run sent again is stored once and replaced whole, unless an older Report arrives late', async () => {
  await using h = await startHub();
  const started = NOW - 3600_000;
  await send(h, [jobRun(started, { output: { file: 'a.log', sizeBytes: 1 } })], { sentAt: NOW });
  await send(h, [jobRun(started, { exitStatus: 1 })], { sentAt: NOW + 1000 });
  await send(h, [jobRun(started, { exitStatus: 9, output: { file: 'old.log', sizeBytes: 5 } })], {
    receivedAt: NOW + 2000,
    sentAt: NOW - 1000,
  });

  expect(await stored(h)).toMatchObject([
    { exit_status: 1, output_file: null, output_size_bytes: null, sent_at: new Date(NOW + 1000) },
  ]);
});

// A held run claiming a time later than the Hub's clock came from a clock that
// ran ahead, so the next Report replaces it even though it was sent earlier.
test('a run first sent from a clock an hour ahead is replaced once the clock is right', async () => {
  await using h = await startHub();
  const started = NOW - 3600_000;
  await send(h, [jobRun(started, { exitStatus: 1 })], { receivedAt: NOW, sentAt: NOW + 3600_000 });
  await send(h, [jobRun(started, { exitStatus: 0 })], { sentAt: NOW + 60_000 });

  expect(await stored(h)).toMatchObject([{ exit_status: 0, sent_at: new Date(NOW + 60_000) }]);
});

test('runs from year 0000 to 9999 are stored in any order, even without a mirrored job', async () => {
  await using h = await startHub();
  // The Hub's clock is in year 9999 too, so the late run is not ahead of it.
  await send(
    h,
    [
      jobRun(Date.parse('9999-12-31T23:59:50Z'), { job: 'late' }),
      jobRun(Date.parse('0000-01-01T00:00:00Z'), { job: 'early' }),
    ],
    { receivedAt: Date.parse('9999-12-31T23:59:59Z') },
  );

  expect(await stored(h)).toMatchObject([
    { job: 'early', started_at: new Date(Date.parse('0000-01-01T00:00:00Z')) },
    { finished_at: new Date(Date.parse('9999-12-31T23:59:55Z')), job: 'late' },
  ]);
});

test('pruning drops runs older than 90 days only when 14 later runs of the job exist', async () => {
  await using h = await startHub();
  const cutoff = NOW - 90 * DAY;
  // `busy` has 20 runs a day back from the cutoff, so its 14 latest stay and
  // the six before them go; `weekly` has three old runs and loses none; a run
  // exactly at the cutoff stays; another System's job is counted apart.
  await send(h, [
    ...Array.from({ length: 20 }, (_, i) => jobRun(cutoff - (i + 1) * DAY, { job: 'busy' })),
    ...Array.from({ length: 3 }, (_, i) => jobRun(cutoff - (i + 1) * 7 * DAY, { job: 'weekly' })),
    jobRun(cutoff, { job: 'edge' }),
    jobRun(NOW, { job: 'edge' }),
  ]);
  await send(h, [jobRun(cutoff - 30 * DAY, { job: 'busy' })], { system: 'server-1' });

  const deleted = await pruneJobRuns(h.db.sql, NOW);

  const rows: { job: string; n: number; system: string }[] = await h.db.sql`
    SELECT system, job, count(*)::int AS n FROM job_runs GROUP BY system, job ORDER BY system, job
  `;
  expect(deleted).toBe(6);
  expect(rows.map(({ job, n, system }) => [system, job, n])).toEqual([
    ['laptop-1', 'busy', 14],
    ['laptop-1', 'edge', 2],
    ['laptop-1', 'weekly', 3],
    ['server-1', 'busy', 1],
  ]);
});

test('pruning keeps a run exactly 90 days old even when 14 later runs of its job exist', async () => {
  await using h = await startHub();
  const cutoff = NOW - 90 * DAY;
  await send(
    h,
    Array.from({ length: 15 }, (_, i) => jobRun(cutoff + i * DAY)),
  );

  expect(await pruneJobRuns(h.db.sql, NOW)).toBe(0);
  expect(await stored(h)).toHaveLength(15);
});

const sendBody = (h: Awaited<ReturnType<typeof startHub>>, jobRuns: unknown, extra = {}) =>
  push(h.hub, { ...report('laptop-1', [NOW]), ...extra, jobRuns }, { token: 'laptop-token' });

test('a Report with a bad run among good ones stores the good runs and the other sections', async () => {
  await using h = await startHub();
  const started = NOW - 3600_000;
  const response = await sendBody(
    h,
    {
      runs: [jobRun(started), jobRun(started + 1000, { exitStatus: 256 }), jobRun(started + 2000)],
    },
    {
      records: {
        records: [
          {
            kind: 'job',
            name: 'backup',
            record: {
              label: 'com.example.backup',
              name: 'backup',
              schedule: [{ hour: 3 }],
              scheduler: 'launchd',
            },
          },
        ],
        unreadable: [],
      },
      runs: {
        jobs: [{ job: 'backup', latestRun: jobRun(started), latestSuccess: null }],
        unreadable: [],
      },
    },
  );

  expect(response.status).toBe(200);
  expect(await stored(h)).toMatchObject([
    { started_at: new Date(started) },
    { started_at: new Date(started + 2000) },
  ]);
  const mirrored: { name: string }[] = await h.db.sql`SELECT name FROM mirrored_records`;
  expect(mirrored.map((row) => row.name)).toEqual(['backup']);
  const latest: { job: string }[] = await h.db.sql`SELECT job FROM mirrored_runs`;
  expect(latest.map((row) => row.job)).toEqual(['backup']);
  expect(await h.db.sql`SELECT 1 FROM conditions WHERE kind = 'reports_rejected'`).toHaveLength(0);
});

test('a null and a string entry are dropped and the runs around them stored', async () => {
  await using h = await startHub();
  const started = NOW - 3600_000;

  const response = await sendBody(h, { runs: [null, jobRun(started), 'backup'] });

  expect(response.status).toBe(200);
  expect(await stored(h)).toHaveLength(1);
  expect(h.warnings).toHaveLength(2);
});

test('the first run of a key is kept, and an invalid run of the key does not shadow a later valid one', async () => {
  await using h = await startHub();
  const started = NOW - 3600_000;

  await sendBody(h, {
    runs: [jobRun(started, { exitStatus: 7 }), jobRun(started, { exitStatus: 8 })],
  });
  await sendBody(h, {
    runs: [jobRun(started + 1000, { exitStatus: 999 }), jobRun(started + 1000, { exitStatus: 2 })],
  });

  expect(await stored(h)).toMatchObject([
    { exit_status: 7, started_at: new Date(started) },
    { exit_status: 2, started_at: new Date(started + 1000) },
  ]);
});

test('a run more than 5 minutes ahead of the Hub clock at arrival is dropped and one exactly 5 minutes ahead kept', async () => {
  await using h = await startHub();
  const edge = NOW + 5 * MINUTE;

  const response = await sendBody(h, {
    runs: [
      jobRun(edge, { finished: whole(edge) }),
      jobRun(edge + 1000, { finished: whole(edge + 1000), job: 'ahead' }),
    ],
  });

  expect(response.status).toBe(200);
  expect(await stored(h)).toMatchObject([
    { job: 'backup', started_at: new Date(NOW + 5 * MINUTE) },
  ]);
  expect(h.warnings).toHaveLength(1);
});

test('a run that starts before the Hub clock but finishes more than 5 minutes after it is dropped', async () => {
  await using h = await startHub();

  const response = await sendBody(h, {
    runs: [
      jobRun(NOW, { finished: whole(NOW + 5 * MINUTE) }),
      jobRun(NOW, { finished: whole(NOW + 5 * MINUTE + 1000), job: 'ahead' }),
    ],
  });

  expect(response.status).toBe(200);
  expect(await stored(h)).toMatchObject([{ job: 'backup', started_at: new Date(NOW) }]);
  expect(h.warnings).toHaveLength(1);
});

test('the runs mirror measures a latest run against the Hub clock at arrival, not the Report sentAt', async () => {
  await using h = await startHub();
  const ahead = NOW + 30 * MINUTE;

  const response = await sendBody(
    h,
    { runs: [] },
    {
      runs: {
        jobs: [{ job: 'backup', latestRun: jobRun(ahead), latestSuccess: null }],
        unreadable: [],
      },
      sentAt: NOW + 60 * MINUTE,
    },
  );

  expect(response.status).toBe(200);
  expect(await h.db.sql`SELECT job FROM mirrored_runs`).toHaveLength(0);
  const sets: { unreadable: string[] }[] = await h.db.sql`SELECT unreadable FROM run_sets`;
  expect(sets.map((set) => set.unreadable)).toEqual([['backup']]);
});

// A job counted unreadable still ran, so the dashboard keeps showing its last
// readable run rather than a job that never ran.
test('a mirrored job whose next latest run is stamped ahead keeps its held runs and counts unreadable', async () => {
  await using h = await startHub();
  const eight = NOW - 4 * 3600_000;
  const latest = (latestRun: SentJobRun, sentAt: number) =>
    storeReport(h.db.sql, {
      onWarn: (message) => h.warnings.push(message),
      receivedAt: sentAt,
      report: {
        ...report('laptop-1', []),
        runs: { jobs: [{ job: 'backup', latestRun, latestSuccess: latestRun }], unreadable: [] },
        sentAt,
      },
    });
  await latest(jobRun(eight), NOW);

  await latest(jobRun(NOW + 11 * MINUTE), NOW + MINUTE);

  const mirrored = await h.db.sql`
    SELECT job, latest_run->>'started' AS run, latest_success->>'started' AS success FROM mirrored_runs
  `;
  expect(mirrored).toEqual([{ job: 'backup', run: whole(eight), success: whole(eight) }]);
  const sets: { unreadable: string[] }[] = await h.db.sql`SELECT unreadable FROM run_sets`;
  expect(sets.map((set) => set.unreadable)).toEqual([['backup']]);
});

test('a dropped replacement leaves the run stored earlier as it was', async () => {
  await using h = await startHub();
  const started = NOW - 3600_000;
  await send(h, [jobRun(started, { exitStatus: 1 })]);

  await sendBody(h, { runs: [jobRun(started, { exitStatus: 300 })] }, { sentAt: NOW + 1000 });

  expect(await stored(h)).toMatchObject([{ exit_status: 1, sent_at: new Date(NOW) }]);
});

test.each([
  ['a jobRuns that is not an object', 'runs'],
  ['a runs that is not an array', { runs: {} }],
  ['1,001 entries', { runs: Array.from({ length: 1001 }, () => null) }],
])('%s answers 422 and stores nothing', async (_, jobRuns) => {
  await using h = await startHub();

  const response = await sendBody(h, jobRuns);

  expect(response.status).toBe(422);
  expect(await stored(h)).toEqual([]);
});

test('each dropped run logs one warning naming the System, the job and start when known, and why', async () => {
  await using h = await startHub();
  const started = NOW - 3600_000;

  await sendBody(h, {
    runs: [
      jobRun(started, { exitStatus: 256 }),
      null,
      jobRun(started + 1000),
      jobRun(started + 1000),
    ],
  });

  expect(h.warnings).toHaveLength(3);
  expect(h.warnings[0]).toContain('laptop-1');
  expect(h.warnings[0]).toContain('backup');
  expect(h.warnings[0]).toContain(whole(started));
  expect(h.warnings[0]).toContain('exitStatus');
  expect(h.warnings[1]).toContain('laptop-1');
  expect(h.warnings[2]).toContain('repeats');
});

// A Report the Hub fails to store answers a server error, and the Collector
// sends it again, so its drops are told only once a store commits. The store
// fails at its last step, clearing the Reports-rejected Condition an invalid
// Report raised, after the runs were taken.
test('a Report the Hub fails to store logs no drop warning, and once stored logs each drop once', async () => {
  await using h = await startHub();
  const started = NOW - 3600_000;
  expect((await sendBody(h, 'runs')).status).toBe(422);
  await h.db.sql`
    CREATE FUNCTION refuse_clear() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'clear refused'; END $$
  `;
  await h.db.sql`
    CREATE TRIGGER refuse BEFORE UPDATE ON conditions FOR EACH ROW EXECUTE FUNCTION refuse_clear()
  `;
  const runs = { runs: [jobRun(started, { exitStatus: 256 }), jobRun(started + 1000)] };

  const failed = await sendBody(h, runs);

  expect(failed.status).toBe(503);
  expect(await stored(h)).toEqual([]);
  expect(h.warnings).toEqual([]);

  await h.db.sql`DROP TRIGGER refuse ON conditions`;
  const response = await sendBody(h, runs);

  expect(response.status).toBe(200);
  expect(h.warnings).toHaveLength(1);
  expect(h.warnings[0]).toContain('exitStatus');
});

test('a dropped run with a 2 MB job name logs a warning of bounded length', async () => {
  await using h = await startHub();

  await sendBody(h, { runs: [jobRun(NOW - 3600_000, { job: 'b'.repeat(2 * 1024 * 1024) })] });

  expect(h.warnings).toHaveLength(1);
  expect(h.warnings[0]).toContain('laptop-1');
  expect(h.warnings[0]?.length).toBeLessThan(1000);
});
