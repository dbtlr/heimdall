import { expect, test } from 'bun:test';

import type { SentJobRun } from '@heimdall/schema';

import { pruneJobRuns } from './retention.ts';
import { storeReport } from './store.ts';
import { NOW, report, startHub } from './testing/hub.ts';
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
  await send(h, [
    jobRun(Date.parse('9999-12-31T23:59:50Z'), { job: 'late' }),
    jobRun(Date.parse('0000-01-01T00:00:00Z'), { job: 'early' }),
  ]);

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
