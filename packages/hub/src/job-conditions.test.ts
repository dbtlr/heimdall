import { describe, expect, test } from 'bun:test';

import { MAX_SAMPLES_PER_REPORT } from '@heimdall/schema';
import type { JobRecord, RunRecord } from '@heimdall/schema';

import { evaluateJobConditions } from './job-conditions.ts';
import { migrate, MIGRATIONS } from './migrations.ts';
import { listSystems } from './store.ts';
import { page, push, report, startHub } from './testing/hub.ts';
import type { Hub } from './testing/hub.ts';
import { testDatabase } from './testing/postgres.ts';

// Times are on 6 October 2026, when New York is UTC-4: the backup is
// scheduled for 03:30 there, which is 07:30 UTC.
const at = (time: string) => Date.parse(`2026-10-06T${time}Z`);

const BACKUP: JobRecord = {
  label: 'com.example.backup',
  name: 'backup',
  schedule: [{ hour: 3, minute: 30 }],
  scheduler: 'launchd',
};

const jobRecord = (record: JobRecord) => ({ kind: 'job', name: record.name, record });

// A record set holding `records`, as a Collector sends it.
const set = (...records: JobRecord[]) => ({ records: records.map(jobRecord), unreadable: [] });

// A run of `job` started at `started` that took a minute, with `exitStatus`.
const run = (started: string, exitStatus = 0): RunRecord => ({
  exitStatus,
  finished: new Date(at(started) + 60_000).toISOString().replace('.000Z', 'Z'),
  started: new Date(at(started)).toISOString().replace('.000Z', 'Z'),
});

// A runs section holding one job's latest run and latest success.
const runsOf = (job: string, latestRun: RunRecord, latestSuccess: RunRecord | null) => ({
  jobs: [{ job, latestRun, latestSuccess }],
  unreadable: [],
});

// A sample every 15 seconds from `from` until before `to`: the System was
// awake for that span.
const awake = (from: string, to: string) =>
  Array.from({ length: (at(to) - at(from)) / 15_000 }, (_, i) => at(from) + i * 15_000);

// Sends laptop-1's Reports at `time` on the Hub's clock, carrying `samples`
// and, in the first, the given sections. The System is in New York unless
// `timeZone` is null.
const send = async (
  h: Hub,
  time: string,
  {
    records,
    runs,
    samples = [at(time)],
    timeZone = 'America/New_York',
  }: { records?: unknown; runs?: unknown; samples?: number[]; timeZone?: string | null },
) => {
  h.clock.now = at(time);
  for (let i = 0; i < samples.length; i += MAX_SAMPLES_PER_REPORT) {
    const first = i === 0;
    // oxlint-disable-next-line no-await-in-loop -- Reports arrive in order.
    const response = await push(
      h.hub,
      {
        ...report('laptop-1', samples.slice(i, i + MAX_SAMPLES_PER_REPORT)),
        sentAt: h.clock.now,
        ...(first && records !== undefined ? { records } : {}),
        ...(first && runs !== undefined ? { runs } : {}),
        ...(timeZone === null ? {} : { timeZone }),
      },
      { token: 'laptop-token' },
    );
    expect(response.status).toBe(200);
  }
};

// Evaluates job Conditions at `time`, then answers laptop-1's open Conditions
// and Timeline.
const evaluate = async (h: Hub, time: string) => {
  h.clock.now = at(time);
  await evaluateJobConditions(h.db.sql, h.clock.now);
  const laptop = (await listSystems(h.db.sql)).find((s) => s.name === 'laptop-1');
  return { open: laptop?.conditions ?? [], timeline: laptop?.timeline ?? [] };
};

// The backup was recorded at 02:00 New York time and the System stayed awake,
// with no run, from then until `until`.
const recordedAndAwake = async (h: Hub, until: string) => {
  await send(h, '06:00:00', { records: set(BACKUP), runs: { jobs: [], unreadable: [] } });
  await send(h, until, { samples: awake('06:00:15', until) });
};

describe('job failing', () => {
  test('is raised for a job whose latest run exited nonzero', async () => {
    await using h = await startHub();
    const failed = run('07:30:00', 3);
    await send(h, '07:40:00', { records: set(BACKUP), runs: runsOf('backup', failed, null) });

    const { open } = await evaluate(h, '07:41:00');

    expect(open).toEqual([
      {
        kind: 'job_failing',
        raisedAt: at('07:41:00'),
        reason: 'The run started 2026-10-06T07:30:00Z exited with status 3.',
        subject: 'backup',
      },
    ]);
  });
});

describe('job failing, continued', () => {
  test('clears when the latest run succeeds, and the Timeline keeps both', async () => {
    await using h = await startHub();
    const failed = run('07:30:00', 1);
    await send(h, '07:40:00', { records: set(BACKUP), runs: runsOf('backup', failed, null) });
    await evaluate(h, '07:41:00');
    const succeeded = run('08:00:00');
    await send(h, '08:10:00', { runs: runsOf('backup', succeeded, succeeded) });

    const { open, timeline } = await evaluate(h, '08:11:00');

    expect(open).toEqual([]);
    expect(timeline).toEqual([
      { at: at('08:11:00'), condition: 'job_failing', kind: 'cleared', subject: 'backup' },
      {
        at: at('07:41:00'),
        condition: 'job_failing',
        kind: 'raised',
        reason: 'The run started 2026-10-06T07:30:00Z exited with status 1.',
        subject: 'backup',
      },
    ]);
  });

  test('stays one Condition while the job keeps failing, with the latest reason', async () => {
    await using h = await startHub();
    await send(h, '07:40:00', {
      records: set(BACKUP),
      runs: runsOf('backup', run('07:30:00', 1), null),
    });
    await evaluate(h, '07:41:00');
    await evaluate(h, '07:42:00');
    await send(h, '08:10:00', { runs: runsOf('backup', run('08:00:00', 2), null) });

    const { open } = await evaluate(h, '08:11:00');

    expect(open).toEqual([
      {
        kind: 'job_failing',
        raisedAt: at('07:41:00'),
        reason: 'The run started 2026-10-06T08:00:00Z exited with status 2.',
        subject: 'backup',
      },
    ]);
  });
});

describe('job overdue', () => {
  test('is raised once the System was awake for an hour after a scheduled time with no run', async () => {
    await using h = await startHub();
    await recordedAndAwake(h, '08:45:00');

    const { open } = await evaluate(h, '08:45:00');

    expect(open).toEqual([
      {
        kind: 'job_overdue',
        raisedAt: at('08:45:00'),
        reason: 'Scheduled for 2026-10-06 03:30 America/New_York; no successful run since.',
        subject: 'backup',
      },
    ]);
  });

  test('is not raised before the hour of awake time is up', async () => {
    await using h = await startHub();
    await recordedAndAwake(h, '08:20:00');

    expect((await evaluate(h, '08:20:00')).open).toEqual([]);
  });

  test('is not raised when a run started at or after the scheduled time succeeded', async () => {
    await using h = await startHub();
    await recordedAndAwake(h, '08:45:00');
    const succeeded = run('07:30:00');
    await send(h, '08:45:00', { runs: runsOf('backup', succeeded, succeeded) });

    expect((await evaluate(h, '08:45:00')).open).toEqual([]);
  });

  test('counts only awake time: a System asleep through the scheduled time gets an hour after waking', async () => {
    await using h = await startHub();
    // Recorded at 02:00, asleep from 02:10 until 11:00 New York time.
    await send(h, '06:00:00', {
      records: set(BACKUP),
      runs: { jobs: [], unreadable: [] },
      samples: awake('06:00:00', '06:10:00'),
    });
    await send(h, '15:40:00', { samples: awake('15:00:00', '15:40:00') });

    expect((await evaluate(h, '15:40:00')).open).toEqual([]);

    await send(h, '16:10:00', { samples: awake('15:40:00', '16:10:00') });

    expect((await evaluate(h, '16:10:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_overdue', subject: 'backup' }),
    ]);
  });

  test('clears once a successful run is reported', async () => {
    await using h = await startHub();
    await recordedAndAwake(h, '08:45:00');
    await evaluate(h, '08:45:00');
    const succeeded = run('08:50:00');
    await send(h, '08:55:00', { runs: runsOf('backup', succeeded, succeeded) });

    const { open, timeline } = await evaluate(h, '08:55:00');

    expect(open).toEqual([]);
    expect(timeline[0]).toEqual({
      at: at('08:55:00'),
      condition: 'job_overdue',
      kind: 'cleared',
      subject: 'backup',
    });
  });

  test('ignores scheduled times before the Hub first mirrored the job', async () => {
    await using h = await startHub();
    // Awake from 02:00, but the backup is first recorded at 04:00, after 03:30.
    await send(h, '06:00:00', { runs: { jobs: [], unreadable: [] } });
    await send(h, '08:00:00', { records: set(BACKUP), samples: awake('06:00:15', '08:00:00') });
    await send(h, '10:00:00', { samples: awake('08:00:00', '10:00:00') });

    expect((await evaluate(h, '10:00:00')).open).toEqual([]);
  });

  test('a job recorded again keeps the time it was first mirrored', async () => {
    await using h = await startHub();
    await send(h, '06:00:00', { records: set(BACKUP), runs: { jobs: [], unreadable: [] } });
    await send(h, '08:00:00', {
      records: set({ ...BACKUP, label: 'com.example.backup2' }),
      samples: awake('06:00:15', '08:00:00'),
    });
    await send(h, '08:45:00', { samples: awake('08:00:00', '08:45:00') });

    expect((await evaluate(h, '08:45:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_overdue', subject: 'backup' }),
    ]);
  });

  test("waits for the job's own grace period when its record sets one", async () => {
    await using h = await startHub();
    const patient = { ...BACKUP, graceMinutes: 180 };
    await send(h, '06:00:00', { records: set(patient), runs: { jobs: [], unreadable: [] } });
    await send(h, '10:20:00', { samples: awake('06:00:15', '10:20:00') });

    expect((await evaluate(h, '10:20:00')).open).toEqual([]);

    await send(h, '10:45:00', { samples: awake('10:20:00', '10:45:00') });

    expect((await evaluate(h, '10:45:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_overdue', subject: 'backup' }),
    ]);
  });

  test('is left unknown, and not raised, while the System has reported no time zone', async () => {
    await using h = await startHub();
    await send(h, '06:00:00', {
      records: set(BACKUP),
      runs: { jobs: [], unreadable: [] },
      timeZone: null,
    });
    await send(h, '08:45:00', { samples: awake('06:00:15', '08:45:00'), timeZone: null });

    expect((await evaluate(h, '08:45:00')).open).toEqual([]);
  });
});

describe('unknown runs or records', () => {
  test('a System that never sent runs raises nothing', async () => {
    await using h = await startHub();
    await send(h, '06:00:00', { records: set(BACKUP) });
    await send(h, '08:45:00', { samples: awake('06:00:15', '08:45:00') });

    expect((await evaluate(h, '08:45:00')).open).toEqual([]);
  });

  test('runs over budget leave open Conditions as they are', async () => {
    await using h = await startHub();
    await send(h, '07:40:00', {
      records: set(BACKUP),
      runs: runsOf('backup', run('07:30:00', 1), null),
    });
    await evaluate(h, '07:41:00');
    await send(h, '08:00:00', { runs: { overBudget: { bytes: 2_000_000 } } });

    expect((await evaluate(h, '08:01:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_failing', subject: 'backup' }),
    ]);
  });

  test('a record set over budget leaves open Conditions as they are', async () => {
    await using h = await startHub();
    await send(h, '07:40:00', {
      records: set(BACKUP),
      runs: runsOf('backup', run('07:30:00', 1), null),
    });
    await evaluate(h, '07:41:00');
    await send(h, '08:00:00', { records: { overBudget: { bytes: 9_000_000 } } });

    expect((await evaluate(h, '08:01:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_failing', subject: 'backup' }),
    ]);
  });

  test('a job whose record the Collector could not read keeps its Conditions', async () => {
    await using h = await startHub();
    await send(h, '07:40:00', {
      records: set(BACKUP),
      runs: runsOf('backup', run('07:30:00', 1), null),
    });
    await evaluate(h, '07:41:00');
    await send(h, '08:00:00', {
      records: { records: [], unreadable: [{ kind: 'job', name: 'backup' }] },
    });

    expect((await evaluate(h, '08:01:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_failing', subject: 'backup' }),
    ]);
  });

  test('a forgotten job clears its Conditions', async () => {
    await using h = await startHub();
    await send(h, '07:40:00', {
      records: set(BACKUP),
      runs: runsOf('backup', run('07:30:00', 1), null),
    });
    await evaluate(h, '07:41:00');
    await send(h, '08:00:00', { records: set(), runs: { jobs: [], unreadable: [] } });

    expect((await evaluate(h, '08:01:00')).open).toEqual([]);
  });
});

test('the page names the job a Condition is about', async () => {
  await using h = await startHub();
  await send(h, '07:40:00', {
    records: set(BACKUP),
    runs: runsOf('backup', run('07:30:00', 1), null),
  });
  await evaluate(h, '07:41:00');

  const html = await page(h.hub);

  expect(html).toContain('<strong>Job failing</strong> <code>backup</code> since');
  expect(html).toContain('Job failing <code>backup</code>:');
});

test('migration 9 counts records mirrored before it from when it applied', async () => {
  await using db = await testDatabase();
  await migrate(
    db.sql,
    MIGRATIONS.filter((m) => m.version <= 8),
  );
  await db.sql`INSERT INTO systems (name, last_seen_at) VALUES ('laptop-1', now())`;
  await db.sql`
    INSERT INTO mirrored_records (system, kind, name, record)
    VALUES ('laptop-1', 'job', 'backup', ${JSON.stringify(BACKUP)}::jsonb)
  `;
  const before = Date.now();

  expect(await migrate(db.sql)).toEqual([9]);

  const [row]: { mirrored_since: Date }[] =
    await db.sql`SELECT mirrored_since FROM mirrored_records`;
  expect(row?.mirrored_since.getTime()).toBeGreaterThanOrEqual(before - 1000);
});
