import { beforeAll, describe, expect, test } from 'bun:test';

import { NOW, report, startHub, storeReport, timeline } from '@heimdall/hub/testing';
import type { Hub } from '@heimdall/hub/testing';

import { readJobs } from './jobs.ts';

// A test run on its own would otherwise pay for `initdb` within its timeout.
beforeAll(async () => {
  const h = await startHub();
  await h.db[Symbol.asyncDispose]();
}, 60_000);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// NOW is 12:00 UTC on Tuesday 6 October 2026; the jobs below run daily at
// 03:00 unless a test gives another schedule.
const { addCondition } = timeline(NOW);

const at = (ms: number) => new Date(ms);

// A System that has reported, in UTC.
const addSystem = async (h: Hub, system: string) => {
  await storeReport(h.db.sql, { receivedAt: NOW, report: report(system, [NOW]) });
  await h.db.sql`UPDATE systems SET time_zone = 'UTC' WHERE name = ${system}`;
};

// A job `name` recorded on `system`, daily at 03:00 unless `schedule` says
// otherwise, and first mirrored `mirroredDaysAgo` days ago.
const recordJob = async (
  h: Hub,
  system: string,
  name: string,
  {
    graceMinutes,
    mirroredDaysAgo = 3,
    schedule = [{ hour: 3, minute: 0 }],
  }: {
    graceMinutes?: number;
    mirroredDaysAgo?: number;
    schedule?: Record<string, number>[];
  } = {},
) => {
  const record = JSON.stringify({
    label: name,
    name,
    schedule,
    scheduler: 'launchd',
    ...(graceMinutes === undefined ? {} : { graceMinutes }),
  });
  await h.db.sql`
    INSERT INTO mirrored_records (system, kind, name, record)
    VALUES (${system}, 'job', ${name}, ${record}::text::jsonb)
  `;
  await h.db.sql`
    INSERT INTO records_first_mirrored (system, kind, name, first_mirrored_at)
    VALUES (${system}, 'job', ${name}, ${at(NOW - mirroredDaysAgo * DAY)})
  `;
};

// A stored run of `job` that started at `started`, taking a minute.
const storeRun = (h: Hub, system: string, job: string, started: number, exitStatus = 0) =>
  h.db.sql`
    INSERT INTO job_runs (system, job, started_at, finished_at, exit_status, sent_at, received_at)
    VALUES (${system}, ${job}, ${at(started)}, ${at(started + MINUTE)}, ${exitStatus},
      ${at(NOW)}, ${at(NOW)})
  `;

// 03:00 `days` days before today.
const daysAgo = (days: number) => NOW - days * DAY - 9 * HOUR;

// The stored run of `job` that started at 03:00 `days` days before today.
const addRun = (h: Hub, system: string, job: string, days: number, exitStatus = 0) =>
  storeRun(h, system, job, daysAgo(days), exitStatus);

// The latest run the Hub mirrors for `job`, as its runs section reported it.
const mirrorRun = (h: Hub, system: string, job: string, started: number, exitStatus = 0) => {
  const run = JSON.stringify({
    exitStatus,
    finished: at(started + MINUTE).toISOString(),
    started: at(started).toISOString(),
  });
  return h.db.sql`
    INSERT INTO mirrored_runs (system, job, latest_run)
    VALUES (${system}, ${job}, ${run}::text::jsonb)
    ON CONFLICT (system, job) DO UPDATE SET latest_run = excluded.latest_run
  `;
};

const kinds = (strip: { kind: string }[] | undefined) => strip?.map(({ kind }) => kind);

describe('readJobs', () => {
  test('lists failing jobs first, then overdue, then the rest, each with its strip and when it is next due', async () => {
    await using h = await startHub();
    await addSystem(h, 'server-1');
    for (const name of ['backup', 'rotate', 'sync']) {
      // oxlint-disable-next-line no-await-in-loop -- one row per job.
      await recordJob(h, 'server-1', name);
    }
    // `backup` failed today; `rotate` last ran three days ago and has missed
    // every time since; `sync` ran every day.
    await addRun(h, 'server-1', 'backup', 2);
    await addRun(h, 'server-1', 'backup', 1);
    await addRun(h, 'server-1', 'backup', 0, 1);
    await mirrorRun(h, 'server-1', 'backup', daysAgo(0), 1);
    await addRun(h, 'server-1', 'rotate', 3);
    await mirrorRun(h, 'server-1', 'rotate', daysAgo(3));
    await addCondition(h.db.sql, {
      kind: 'job_overdue',
      raisedAt: -(5 * 3600),
      subject: 'rotate',
      system: 'server-1',
    });
    // `sync` also ran before the Hub mirrored it, and skipped the two days between.
    await addRun(h, 'server-1', 'sync', 5);
    for (const days of [2, 1, 0]) {
      // oxlint-disable-next-line no-await-in-loop -- one row per run.
      await addRun(h, 'server-1', 'sync', days);
    }
    await mirrorRun(h, 'server-1', 'sync', daysAgo(0));

    const { jobs } = await readJobs(h.db.sql, NOW);

    expect(jobs.map(({ name, state }) => [name, state])).toEqual([
      ['backup', 'failing'],
      ['rotate', 'overdue'],
      ['sync', 'ok'],
    ]);
    expect(jobs.map(({ strip }) => kinds(strip))).toEqual([
      ['ok', 'ok', 'failed'],
      ['ok', 'missed', 'missed', 'missed'],
      ['ok', 'missed', 'missed', 'ok', 'ok', 'ok'],
    ]);
    expect(jobs.map(({ nextDue }) => nextDue)).toEqual(Array(3).fill(Date.UTC(2026, 9, 7, 3)));
    expect(jobs[0]?.latestRun).toEqual({
      exitStatus: 1,
      finished: daysAgo(0) + MINUTE,
      started: daysAgo(0),
    });
    expect(jobs[1]?.wasDueAt).toBe(Date.UTC(2026, 9, 6, 3));
    expect(jobs[1]?.scheduler).toBe('launchd');
    expect(jobs[1]?.timeZone).toBe('UTC');
  });

  test('takes the latest run and state from the mirror, and adds it to the strip when the history does not hold it yet', async () => {
    await using h = await startHub();
    await addSystem(h, 'server-1');
    await recordJob(h, 'server-1', 'backup');
    await recordJob(h, 'server-1', 'sync');
    // `backup` failed at 03:00 today, and the history holds only the runs before.
    await addRun(h, 'server-1', 'backup', 2);
    await addRun(h, 'server-1', 'backup', 1);
    await mirrorRun(h, 'server-1', 'backup', daysAgo(0), 1);
    await addCondition(h.db.sql, {
      kind: 'job_failing',
      raisedAt: -(8 * 3600),
      subject: 'backup',
      system: 'server-1',
    });
    // `sync` failed at 03:00 and a rerun at 11:00 succeeded, which only the
    // mirror holds, so the Hub has no Job failing open.
    await addRun(h, 'server-1', 'sync', 1);
    await addRun(h, 'server-1', 'sync', 0, 1);
    await mirrorRun(h, 'server-1', 'sync', NOW - HOUR);

    const { jobs } = await readJobs(h.db.sql, NOW);
    const backup = jobs.find(({ name }) => name === 'backup');
    const sync = jobs.find(({ name }) => name === 'sync');

    expect(backup?.state).toBe('failing');
    expect(backup?.latestRun?.started).toBe(daysAgo(0));
    expect(backup?.latestRun?.exitStatus).toBe(1);
    expect(kinds(backup?.strip)).toEqual(['ok', 'ok', 'failed']);
    expect(sync?.state).toBe('ok');
    expect(sync?.latestRun?.started).toBe(NOW - HOUR);
    expect(kinds(sync?.strip)).toEqual(['missed', 'ok', 'failed', 'ok']);
  });

  test('calls no time missed before the history it holds, for a weekly or monthly job with fewer than 14 runs', async () => {
    await using h = await startHub();
    await addSystem(h, 'server-1');
    // Mirrored long ago, but the history starts with the Collector's 90 days.
    await recordJob(h, 'server-1', 'weekly', {
      mirroredDaysAgo: 365,
      schedule: [{ hour: 3, minute: 0, weekday: 2 }],
    });
    await recordJob(h, 'server-1', 'monthly', {
      mirroredDaysAgo: 730,
      schedule: [{ day: 1, hour: 3, minute: 0 }],
    });
    for (let week = 0; week < 13; week += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one row per run.
      await addRun(h, 'server-1', 'weekly', 7 * week);
    }
    for (const month of [7, 8, 9]) {
      // oxlint-disable-next-line no-await-in-loop -- one row per run.
      await storeRun(h, 'server-1', 'monthly', Date.UTC(2026, month, 1, 3));
    }

    const { jobs } = await readJobs(h.db.sql, NOW);

    expect(kinds(jobs.find(({ name }) => name === 'weekly')?.strip)).toEqual(Array(13).fill('ok'));
    expect(kinds(jobs.find(({ name }) => name === 'monthly')?.strip)).toEqual(['ok', 'ok', 'ok']);
  });

  test('gives a job that never ran on a System that sends history its missed times, and a System that sends none no strip', async () => {
    await using h = await startHub();
    await addSystem(h, 'server-1');
    await addSystem(h, 'laptop-1');
    await recordJob(h, 'server-1', 'backup');
    await recordJob(h, 'server-1', 'prune', { mirroredDaysAgo: 2 });
    await addRun(h, 'server-1', 'backup', 0);
    await recordJob(h, 'laptop-1', 'sync');
    await mirrorRun(h, 'laptop-1', 'sync', daysAgo(0));

    const { jobs } = await readJobs(h.db.sql, NOW);
    const prune = jobs.find(({ name }) => name === 'prune');
    const sync = jobs.find(({ name }) => name === 'sync');

    expect(prune?.state).toBe('due');
    expect(kinds(prune?.strip)).toEqual(['missed', 'missed']);
    expect(sync?.strip).toBeUndefined();
    expect(sync?.latestRun?.started).toBe(daysAgo(0));
    expect(sync?.state).toBe('ok');
  });

  test("reads the grace period from the job's record", async () => {
    await using h = await startHub();
    await addSystem(h, 'server-1');
    // Ten hours of grace: today's 03:00 is not missed until 13:00.
    await recordJob(h, 'server-1', 'backup', { graceMinutes: 600 });
    await recordJob(h, 'server-1', 'rotate');
    for (const name of ['backup', 'rotate']) {
      // oxlint-disable-next-line no-await-in-loop -- one row per job.
      await addRun(h, 'server-1', name, 1);
      // oxlint-disable-next-line no-await-in-loop -- one row per job.
      await mirrorRun(h, 'server-1', name, daysAgo(1));
    }

    const { jobs } = await readJobs(h.db.sql, NOW);
    const backup = jobs.find(({ name }) => name === 'backup');
    const rotate = jobs.find(({ name }) => name === 'rotate');

    expect(backup?.graceMinutes).toBe(600);
    expect(kinds(backup?.strip)).toEqual(['missed', 'ok']);
    expect(rotate?.graceMinutes).toBe(60);
    expect(kinds(rotate?.strip)).toEqual(['missed', 'ok', 'missed']);
  });

  test('names the scheduled time an overdue job is overdue for, not one still within its grace', async () => {
    await using h = await startHub();
    await addSystem(h, 'server-1');
    await recordJob(h, 'server-1', 'hourly', { schedule: [{ minute: 0 }] });
    await addRun(h, 'server-1', 'hourly', 0);
    await mirrorRun(h, 'server-1', 'hourly', daysAgo(0));
    await addCondition(h.db.sql, {
      kind: 'job_overdue',
      raisedAt: -(2 * 3600),
      subject: 'hourly',
      system: 'server-1',
    });

    const { jobs } = await readJobs(h.db.sql, NOW + 10 * MINUTE);

    expect(jobs[0]?.state).toBe('overdue');
    expect(jobs[0]?.wasDueAt).toBe(NOW - HOUR);
  });

  test('reads only paired Systems, and the newest 14 runs of a job that has many', async () => {
    await using h = await startHub();
    await addSystem(h, 'server-1');
    await addSystem(h, 'gone-1');
    await recordJob(h, 'server-1', 'backup');
    await recordJob(h, 'gone-1', 'backup');
    for (let hours = 0; hours < 40; hours += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one row per run.
      await storeRun(h, 'server-1', 'backup', NOW - hours * HOUR);
    }
    await mirrorRun(h, 'server-1', 'backup', NOW);

    const { jobs } = await readJobs(h.db.sql, NOW);

    expect(jobs.map(({ system }) => system)).toEqual(['server-1']);
    expect(jobs[0]?.strip).toHaveLength(14);
    expect(jobs[0]?.strip?.at(-1)?.at).toBe(NOW);
  });
});
