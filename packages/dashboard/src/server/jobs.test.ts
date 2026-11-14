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

// NOW is 12:00 UTC; the jobs below run daily at 03:00.
const { addCondition } = timeline(NOW);

const at = (ms: number) => new Date(ms);

// A System that has reported, in UTC.
const addSystem = async (h: Hub, system: string) => {
  await storeReport(h.db.sql, { receivedAt: NOW, report: report(system, [NOW]) });
  await h.db.sql`UPDATE systems SET time_zone = 'UTC' WHERE name = ${system}`;
};

// A job `name` recorded on `system` daily at 03:00 and first mirrored three
// days ago.
const recordJob = async (h: Hub, system: string, name: string) => {
  const record = JSON.stringify({
    label: name,
    name,
    schedule: [{ hour: 3, minute: 0 }],
    scheduler: 'launchd',
  });
  await h.db.sql`
    INSERT INTO mirrored_records (system, kind, name, record)
    VALUES (${system}, 'job', ${name}, ${record}::text::jsonb)
  `;
  await h.db.sql`
    INSERT INTO records_first_mirrored (system, kind, name, first_mirrored_at)
    VALUES (${system}, 'job', ${name}, ${at(NOW - 3 * DAY)})
  `;
};

// The run of `job` that started at 03:00 `days` days before today, taking a minute.
const addRun = (h: Hub, system: string, job: string, days: number, exitStatus = 0) => {
  const started = NOW - days * DAY - 9 * HOUR;
  return h.db.sql`
    INSERT INTO job_runs (system, job, started_at, finished_at, exit_status, sent_at, received_at)
    VALUES (${system}, ${job}, ${at(started)}, ${at(started + MINUTE)}, ${exitStatus},
      ${at(NOW)}, ${at(NOW)})
  `;
};

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
    await addRun(h, 'server-1', 'rotate', 3);
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

    const { jobs } = await readJobs(h.db.sql, NOW);

    expect(jobs.map(({ name, state }) => [name, state])).toEqual([
      ['backup', 'failing'],
      ['rotate', 'overdue'],
      ['sync', 'ok'],
    ]);
    expect(jobs.map(({ strip }) => strip?.map(({ kind }) => kind))).toEqual([
      ['ok', 'ok', 'failed'],
      ['ok', 'missed', 'missed', 'missed'],
      ['ok', 'missed', 'missed', 'ok', 'ok', 'ok'],
    ]);
    expect(jobs.map(({ nextDue }) => nextDue)).toEqual(Array(3).fill(Date.UTC(2026, 9, 7, 3)));
    expect(jobs[0]?.latestRun).toEqual({
      exitStatus: 1,
      finished: NOW - 9 * HOUR + MINUTE,
      started: NOW - 9 * HOUR,
    });
    expect(jobs[1]?.wasDueAt).toBe(Date.UTC(2026, 9, 6, 3));
    expect(jobs[1]?.scheduler).toBe('launchd');
  });

  test('shows the strip as unknown for a job with no stored runs, and its latest run from the mirror', async () => {
    await using h = await startHub();
    await addSystem(h, 'server-1');
    await recordJob(h, 'server-1', 'backup');
    const run = JSON.stringify({
      exitStatus: 0,
      finished: at(NOW - 8 * HOUR).toISOString(),
      started: at(NOW - 9 * HOUR).toISOString(),
    });
    await h.db.sql`
      INSERT INTO mirrored_runs (system, job, latest_run)
      VALUES ('server-1', 'backup', ${run}::text::jsonb)
    `;

    const { jobs } = await readJobs(h.db.sql, NOW);

    expect(jobs[0]?.strip).toBeUndefined();
    expect(jobs[0]?.latestRun?.started).toBe(NOW - 9 * HOUR);
    expect(jobs[0]?.state).toBe('ok');
  });

  test('reads only paired Systems, and the newest 14 runs of a job that has many', async () => {
    await using h = await startHub();
    await addSystem(h, 'server-1');
    await addSystem(h, 'gone-1');
    await recordJob(h, 'server-1', 'backup');
    await recordJob(h, 'gone-1', 'backup');
    for (let hours = 0; hours < 40; hours += 1) {
      const started = NOW - hours * HOUR;
      // oxlint-disable-next-line no-await-in-loop -- one row per run.
      await h.db.sql`
        INSERT INTO job_runs (system, job, started_at, finished_at, exit_status, sent_at, received_at)
        VALUES ('server-1', 'backup', ${at(started)}, ${at(started + MINUTE)}, 0, ${at(NOW)}, ${at(NOW)})
      `;
    }

    const { jobs } = await readJobs(h.db.sql, NOW);

    expect(jobs.map(({ system }) => system)).toEqual(['server-1']);
    expect(jobs[0]?.strip).toHaveLength(14);
    expect(jobs[0]?.strip?.at(-1)?.at).toBe(NOW);
  });
});
