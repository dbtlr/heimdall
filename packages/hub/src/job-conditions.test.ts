import { describe, expect, test } from 'bun:test';

import { MAX_SAMPLES_PER_REPORT } from '@heimdall/schema';
import type { JobRecord, RunRecord } from '@heimdall/schema';

import { evaluateJobConditions, judgeJobConditions } from './job-conditions.ts';
import type { JobConditionFacts } from './job-conditions.ts';
import { migrate, MIGRATIONS } from './migrations.ts';
import { listSystems, push, report, sampleTimes, startHub } from './testing/hub.ts';
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
const awake = (from: string, to: string) => sampleTimes(at(from), at(to));

// Sends a System's Reports, laptop-1's unless `system` says otherwise, at
// `time` on the Hub's clock, carrying `samples` and, in the first, the given
// sections. The System is in New York unless `timeZone` is null.
const send = async (
  h: Hub,
  time: string,
  {
    records,
    runs,
    samples = [at(time)],
    system = 'laptop-1',
    timeZone = 'America/New_York',
  }: {
    records?: unknown;
    runs?: unknown;
    samples?: number[];
    system?: string;
    timeZone?: string | null;
  },
) => {
  h.clock.now = at(time);
  for (let i = 0; i < samples.length; i += MAX_SAMPLES_PER_REPORT) {
    const first = i === 0;
    // oxlint-disable-next-line no-await-in-loop -- Reports arrive in order.
    const response = await push(
      h.hub,
      {
        ...report(system, samples.slice(i, i + MAX_SAMPLES_PER_REPORT)),
        sentAt: h.clock.now,
        ...(first && records !== undefined ? { records } : {}),
        ...(first && runs !== undefined ? { runs } : {}),
        ...(timeZone === null ? {} : { timeZone }),
      },
      { token: system === 'laptop-1' ? 'laptop-token' : 'server-token' },
    );
    expect(response.status).toBe(200);
  }
};

// A System's open Conditions and Timeline.
const conditionsOf = async (h: Hub, system: string) => {
  const found = (await listSystems(h.db.sql)).find((s) => s.name === system);
  return { open: found?.conditions ?? [], timeline: found?.timeline ?? [] };
};

// Evaluates job Conditions at `time` (epoch milliseconds, or a time on
// 6 October), then answers laptop-1's open Conditions and Timeline.
const evaluate = async (h: Hub, time: number | string) => {
  h.clock.now = typeof time === 'number' ? time : at(time);
  await evaluateJobConditions(h.db.sql, () => h.clock.now);
  return conditionsOf(h, 'laptop-1');
};

const NO_RUNS = { jobs: [], unreadable: [] };

// The backup was recorded at 02:00 New York time and the System stayed awake,
// with no run, from then until `until`.
const recordedAndAwake = async (h: Hub, until: string) => {
  await send(h, '06:00:00', { records: set(BACKUP), runs: { jobs: [], unreadable: [] } });
  await send(h, until, { samples: awake('06:00:15', until) });
};

const facts = (overrides: Partial<JobConditionFacts> = {}): JobConditionFacts => ({
  awakeCutoff: () => at('07:30:00'),
  open: ['backup'],
  records: [{ mirroredSince: at('06:00:00'), name: 'backup', record: BACKUP }],
  recordsOverBudget: false,
  runs: new Map(),
  timeZone: 'America/New_York',
  unreadable: new Set(),
  ...overrides,
});

const judge = (overrides: Partial<JobConditionFacts> = {}) =>
  judgeJobConditions(facts(overrides), at('08:30:00')).get('backup');

const overdue = {
  raise: 'Scheduled for 2026-10-06 03:30 America/New_York; no successful run since.',
};

describe('judgeJobConditions', () => {
  test('a nonzero latest run raises failing with its start and exit status, updating the reason on the next failure', () => {
    expect(
      judge({ runs: new Map([['backup', { latestRun: run('07:30:00', 3), latestSuccess: null }]]) })
        ?.job_failing,
    ).toEqual({
      raise: 'The run started 2026-10-06T07:30:00Z exited with status 3.',
    });
    expect(
      judge({ runs: new Map([['backup', { latestRun: run('08:00:00', 2), latestSuccess: null }]]) })
        ?.job_failing,
    ).toEqual({
      raise: 'The run started 2026-10-06T08:00:00Z exited with status 2.',
    });
  });

  test('a successful latest run or no runs clears failing', () => {
    expect(judge()?.job_failing).toBe('clear');
    const success = run('08:00:00');
    expect(
      judge({ runs: new Map([['backup', { latestRun: success, latestSuccess: success }]]) })
        ?.job_failing,
    ).toBe('clear');
  });

  test('overdue is raised exactly when the awake cutoff reaches a scheduled time, including with no runs', () => {
    expect(judge()).toEqual({ job_failing: 'clear', job_overdue: overdue });
    expect(judge({ awakeCutoff: () => at('07:29:59') })?.job_overdue).toBe('clear');
    expect(judge({ awakeCutoff: () => undefined })?.job_overdue).toBe('unknown');
  });

  test('a successful run started at or after the schedule prevents overdue, even if a later run failed', () => {
    for (const started of ['07:30:00', '07:31:00']) {
      expect(
        judge({
          runs: new Map([
            ['backup', { latestRun: run('08:00:00', 2), latestSuccess: run(started) }],
          ]),
        })?.job_overdue,
      ).toBe('clear');
    }
    expect(
      judge({
        runs: new Map([['backup', { latestRun: run('07:29:00'), latestSuccess: run('07:29:00') }]]),
      })?.job_overdue,
    ).toEqual(overdue);
  });

  test('scheduled times before first mirroring are ignored and a missing first time counts from now', () => {
    expect(
      judge({ records: [{ mirroredSince: at('08:00:00'), name: 'backup', record: BACKUP }] })
        ?.job_overdue,
    ).toBe('clear');
    expect(
      judge({ records: [{ mirroredSince: null, name: 'backup', record: BACKUP }] })?.job_overdue,
    ).toBe('clear');
  });

  test('each job asks for its own grace period, with an hour as the default', () => {
    const input = facts({
      awakeCutoff: (graceMs) => (graceMs <= 60 * 60_000 ? at('07:30:00') : undefined),
      records: [
        { mirroredSince: at('06:00:00'), name: 'backup', record: BACKUP },
        {
          mirroredSince: at('06:00:00'),
          name: 'archive',
          record: { ...BACKUP, graceMinutes: 180, name: 'archive' },
        },
      ],
    });
    expect(judgeJobConditions(input, at('08:30:00'))).toEqual(
      new Map([
        ['backup', { job_failing: 'clear', job_overdue: overdue }],
        ['archive', { job_failing: 'clear', job_overdue: 'unknown' }],
      ]),
    );
  });

  test('a missing or unrecognized time zone leaves overdue unknown while failing is still judged', () => {
    for (const timeZone of [null, 'Mars/Olympus_Mons']) {
      expect(
        judge({
          runs: new Map([['backup', { latestRun: run('05:00:00', 1), latestSuccess: null }]]),
          timeZone,
        }),
      ).toEqual({
        job_failing: { raise: 'The run started 2026-10-06T05:00:00Z exited with status 1.' },
        job_overdue: 'unknown',
      });
    }
  });

  test('unknown runs or a record the Hub cannot read leave both Conditions alone', () => {
    expect(judge({ runs: new Map([['backup', 'unknown']]) })).toEqual({
      job_failing: 'unknown',
      job_overdue: 'unknown',
    });
    expect(
      judge({ records: [{ mirroredSince: at('06:00:00'), name: 'backup', record: undefined }] }),
    ).toEqual({ job_failing: 'unknown', job_overdue: 'unknown' });
  });

  test('records over budget judge neither recorded nor forgotten jobs', () => {
    expect(
      judgeJobConditions(facts({ open: ['forgotten'], recordsOverBudget: true }), at('08:30:00')),
    ).toEqual(new Map());
  });

  test('a forgotten job clears both Conditions unless its own record is unreadable', () => {
    expect(judge({ records: [], unreadable: new Set(['other']) })).toEqual({
      job_failing: 'clear',
      job_overdue: 'clear',
    });
    expect(judge({ records: [], unreadable: new Set(['backup']) })).toEqual({
      job_failing: 'unknown',
      job_overdue: 'unknown',
    });
  });
});

describe('job Condition wiring', () => {
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
    expect((await evaluate(h, '08:45:00')).open).toEqual([
      {
        kind: 'job_overdue',
        raisedAt: at('08:45:00'),
        reason: 'Scheduled for 2026-10-06 03:30 America/New_York; no successful run since.',
        subject: 'backup',
      },
    ]);
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

  test('a job forgotten and recorded again counts from when it was recorded again', async () => {
    await using h = await startHub();
    await send(h, '06:00:00', { records: set(BACKUP), runs: NO_RUNS });
    await send(h, '07:00:00', { records: set(), samples: awake('06:00:15', '07:00:00') });
    await send(h, '08:00:00', { records: set(BACKUP), samples: awake('07:00:00', '08:00:00') });
    await send(h, '09:15:00', { samples: awake('08:00:00', '09:15:00') });

    expect((await evaluate(h, '09:15:00')).open).toEqual([]);
  });

  test('is raised when the awake time after a scheduled time is exactly the grace period', async () => {
    await using h = await startHub();
    // Twelve full 5-minute buckets from 07:30.
    await recordedAndAwake(h, '08:30:00');

    expect((await evaluate(h, '08:30:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_overdue', subject: 'backup' }),
    ]);
  });

  test('counts a bucket as awake for no more than its 5 minutes, however many samples it holds', async () => {
    await using h = await startHub();
    await send(h, '06:00:00', { records: set(BACKUP), runs: NO_RUNS });
    // A sample every 5 seconds for the half hour after 03:30.
    const often = Array.from({ length: 360 }, (_, i) => at('07:30:00') + i * 5000);
    await send(h, '08:00:00', { samples: often });

    expect((await evaluate(h, '08:00:00')).open).toEqual([]);
  });

  test("does not count samples stamped after the Hub's clock", async () => {
    await using h = await startHub();
    await send(h, '06:00:00', { records: set(BACKUP), runs: NO_RUNS });
    // Awake until 03:45, with an hour of samples from a clock running ahead.
    const ahead = [...awake('06:00:15', '07:45:00'), ...awake('08:45:00', '09:45:00')];
    await send(h, '07:45:00', { samples: ahead });

    expect((await evaluate(h, '07:45:00')).open).toEqual([]);
  });

  test('stays raised while the System has not been awake for the grace period in 90 days', async () => {
    await using h = await startHub();
    await recordedAndAwake(h, '08:45:00');
    await evaluate(h, '08:45:00');

    const later = at('08:45:00') + 91 * 24 * 60 * 60_000;

    expect((await evaluate(h, later)).open).toEqual([
      expect.objectContaining({ kind: 'job_overdue', subject: 'backup' }),
    ]);
  });

  test('stays raised through a spell when the record set was over budget', async () => {
    await using h = await startHub();
    await recordedAndAwake(h, '08:45:00');
    await evaluate(h, '08:45:00');
    await send(h, '08:50:00', { records: { overBudget: { bytes: 9_000_000 } } });
    await evaluate(h, '08:51:00');
    await send(h, '08:55:00', { records: set(BACKUP) });

    expect((await evaluate(h, '08:56:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_overdue', subject: 'backup' }),
    ]);
  });

  test("stays raised through a spell when the job's record was unreadable", async () => {
    await using h = await startHub();
    await recordedAndAwake(h, '08:45:00');
    await evaluate(h, '08:45:00');
    await send(h, '08:50:00', {
      records: { records: [], unreadable: [{ kind: 'job', name: 'backup' }] },
    });
    await evaluate(h, '08:51:00');
    await send(h, '08:55:00', { records: set(BACKUP) });

    expect((await evaluate(h, '08:56:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_overdue', subject: 'backup' }),
    ]);
  });

  test('judges each job on one System by its own grace period', async () => {
    await using h = await startHub();
    const patient = { ...BACKUP, graceMinutes: 180, name: 'archive' };
    await send(h, '06:00:00', { records: set(BACKUP, patient), runs: NO_RUNS });
    await send(h, '08:45:00', { samples: awake('06:00:15', '08:45:00') });

    expect((await evaluate(h, '08:45:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_overdue', subject: 'backup' }),
    ]);

    await send(h, '10:20:00', { samples: awake('08:45:00', '10:20:00') });

    expect((await evaluate(h, '10:20:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_overdue', subject: 'backup' }),
    ]);

    await send(h, '10:45:00', { samples: awake('10:20:00', '10:45:00') });

    expect((await evaluate(h, '10:45:00')).open.map((c) => c.subject).toSorted()).toEqual([
      'archive',
      'backup',
    ]);
  });

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

  test('a job whose runs the Collector could not read keeps its Conditions', async () => {
    await using h = await startHub();
    await send(h, '07:40:00', {
      records: set(BACKUP),
      runs: runsOf('backup', run('07:30:00', 1), null),
    });
    await evaluate(h, '07:41:00');
    await send(h, '08:00:00', { runs: { jobs: [], unreadable: ['backup'] } });

    expect((await evaluate(h, '08:01:00')).open).toEqual([
      expect.objectContaining({ kind: 'job_failing', subject: 'backup' }),
    ]);
  });
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

  expect(
    await migrate(
      db.sql,
      MIGRATIONS.filter((m) => m.version <= 9),
    ),
  ).toEqual([9]);

  const [row]: { first_mirrored_at: Date; kind: string; name: string }[] = await db.sql`
    SELECT kind, name, first_mirrored_at FROM records_first_mirrored
  `;
  expect(row).toMatchObject({ kind: 'job', name: 'backup' });
  expect(row?.first_mirrored_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
});
