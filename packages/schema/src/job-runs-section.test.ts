import { describe, expect, test } from 'bun:test';

import { FUTURE_SAMPLE_TOLERANCE_MS } from './conditions.ts';
import { JobRunsSectionSchema, MAX_JOB_RUNS_PER_REPORT, takeJobRuns } from './job-runs-section.ts';
import type { JobRunsSection, SentJobRun } from './job-runs-section.ts';
import { ReportSchema } from './report.ts';
import { sample } from './testing.ts';

const report = (extra: { jobRuns?: unknown } = {}) => ({
  collector: { arch: 'x64', platform: 'linux', version: '0.12.0' },
  samples: [sample(1_792_800_000_000)],
  schemaVersion: 1,
  sentAt: 1_792_800_015_000,
  system: 'server-1',
  ...extra,
});

const FAILED: SentJobRun = {
  exitStatus: 1,
  finished: '2026-10-02T03:30:09Z',
  job: 'nightly-backup',
  started: '2026-10-02T03:30:00Z',
};
const SUCCEEDED: SentJobRun = {
  exitStatus: 0,
  finished: '2026-10-01T03:42:17Z',
  job: 'nightly-backup',
  output: { file: 'backup-2026-10-01.tar.gz', sizeBytes: 73_400_320 },
  started: '2026-10-01T03:30:00Z',
};

// The Hub's clock when the Reports in these tests arrive.
const ARRIVAL = Date.parse('2026-10-05T00:00:00Z');

const parsedRuns = (runs: unknown[]) => ReportSchema.safeParse(report({ jobRuns: { runs } }));

const at = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');

const nulls = (count: number) => Array.from({ length: count }, () => null);

describe('a Report', () => {
  test('carries runs of one job and of another job started at the same time, with and without an output file', () => {
    const jobRuns: JobRunsSection = {
      runs: [SUCCEEDED, FAILED, { ...FAILED, job: 'rotate-logs' }],
    };

    expect(ReportSchema.parse(report({ jobRuns })).jobRuns).toEqual(jobRuns);
    expect(JobRunsSectionSchema.parse(jobRuns)).toEqual(jobRuns);
  });

  test('from a Collector that predates the job runs section is accepted and has none', () => {
    const parsed = ReportSchema.safeParse(report());

    expect(parsed.success).toBe(true);
    expect(parsed.data?.jobRuns).toBeUndefined();
  });

  // ADR-0004: a field a newer Collector knows is dropped, and the run kept.
  test('drops fields this Hub does not know from a run, at any depth', () => {
    const fromNewerCollector = {
      ...SUCCEEDED,
      durationMs: 737_000,
      output: { ...SUCCEEDED.output, sha256: 'ab' },
    };

    expect(takeJobRuns([fromNewerCollector], ARRIVAL)).toEqual({ dropped: [], taken: [SUCCEEDED] });
  });

  // The Collector sends the oldest first, which the Hub does not check.
  test('takes runs in any order', () => {
    expect(takeJobRuns([FAILED, SUCCEEDED], ARRIVAL).taken).toEqual([FAILED, SUCCEEDED]);
  });

  test('keeps the first run of a key and drops a later one, with different details or not', () => {
    const { dropped, taken } = takeJobRuns([FAILED, { ...FAILED, exitStatus: 0 }], ARRIVAL);

    expect(taken).toEqual([FAILED]);
    expect(dropped).toEqual([
      { job: FAILED.job, reason: expect.stringContaining('repeats'), started: FAILED.started },
    ]);
  });

  test('does not let an invalid run shadow a later valid run of the same key', () => {
    const invalid = { ...FAILED, exitStatus: 256 };

    const { dropped, taken } = takeJobRuns([invalid, FAILED], ARRIVAL);

    expect(taken).toEqual([FAILED]);
    expect(dropped).toHaveLength(1);
  });

  test('drops an entry that is not an object, naming nothing', () => {
    const { dropped, taken } = takeJobRuns([null, 'backup', 7, [], SUCCEEDED], ARRIVAL);

    expect(taken).toEqual([SUCCEEDED]);
    expect(dropped).toEqual(Array.from({ length: 4 }, () => ({ reason: expect.any(String) })));
  });

  test('names the job and start of a dropped run only when they are strings', () => {
    const { dropped } = takeJobRuns([{ job: 'Not A Name', started: 5 }], ARRIVAL);

    expect(dropped).toEqual([{ job: 'Not A Name', reason: expect.stringContaining('job') }]);
  });

  test('drops a run that starts more than 5 minutes after the Hub clock and keeps one exactly 5 minutes ahead', () => {
    const run = (started: number): SentJobRun => ({
      ...FAILED,
      finished: at(started),
      started: at(started),
    });
    const edge = run(ARRIVAL + FUTURE_SAMPLE_TOLERANCE_MS);
    const over = run(ARRIVAL + FUTURE_SAMPLE_TOLERANCE_MS + 1000);

    const { dropped, taken } = takeJobRuns([edge, over], ARRIVAL);

    expect(taken).toEqual([edge]);
    expect(dropped).toEqual([
      { job: FAILED.job, reason: expect.stringContaining('5 minutes'), started: over.started },
    ]);
  });

  test('takes a run finishing exactly 5 minutes after the Hub clock and drops one finishing a second later', () => {
    const edge = {
      ...FAILED,
      finished: at(ARRIVAL + FUTURE_SAMPLE_TOLERANCE_MS),
      started: at(ARRIVAL),
    };
    const over = {
      ...edge,
      finished: at(ARRIVAL + FUTURE_SAMPLE_TOLERANCE_MS + 1000),
      job: 'other',
    };

    const { dropped, taken } = takeJobRuns([edge, over], ARRIVAL);

    expect(taken).toEqual([edge]);
    expect(dropped).toEqual([
      { job: 'other', reason: expect.stringContaining('finishes'), started: over.started },
    ]);
  });

  test('drops a run that finishes in year 9999 and takes one finishing 4 minutes after the Hub clock', () => {
    const endless = { ...FAILED, finished: '9999-12-31T23:59:59Z', started: at(ARRIVAL) };
    const soon = { ...FAILED, finished: at(ARRIVAL + 4 * 60_000), started: at(ARRIVAL) };

    const { dropped, taken } = takeJobRuns([endless, soon], ARRIVAL);

    expect(taken).toEqual([soon]);
    expect(dropped).toEqual([
      { job: FAILED.job, reason: expect.stringContaining('finishes'), started: endless.started },
    ]);
  });

  test('takes a run from the first second of year 0000', () => {
    const run = { ...FAILED, finished: '0000-01-01T00:00:00Z', started: '0000-01-01T00:00:00Z' };

    expect(takeJobRuns([run], ARRIVAL).taken).toEqual([run]);
  });

  test.each([
    ['an exit status above 255', { exitStatus: 256 }],
    ['a negative exit status', { exitStatus: -1 }],
    ['a fractional exit status', { exitStatus: 1.5 }],
    ['a start with fractional seconds', { started: '2026-10-02T03:30:00.500Z' }],
    ['a start with an offset', { started: '2026-10-02T05:30:00+02:00' }],
    ['a finish before its start', { finished: '2026-10-02T03:29:59Z' }],
    ['no finish', { finished: undefined }],
    ['no job', { job: undefined }],
    ['a job name the records refuse', { job: 'Not A Name' }],
    ['an output file with a directory', { output: { file: 'out/backup.tar', sizeBytes: 1 } }],
    ['an output file of ..', { output: { file: '..', sizeBytes: 1 } }],
    ['a negative output size', { output: { file: 'backup.tar', sizeBytes: -1 } }],
  ])('drops a run with %s', (_, change) => {
    const { dropped, taken } = takeJobRuns([{ ...FAILED, ...change }], ARRIVAL);

    expect(taken).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  test('the strict section schema, kept for the Collector, still fails a run that breaks a rule or repeats a key', () => {
    expect(JobRunsSectionSchema.safeParse({ runs: [{ ...FAILED, exitStatus: 256 }] }).success).toBe(
      false,
    );
    expect(JobRunsSectionSchema.safeParse({ runs: [FAILED, FAILED] }).success).toBe(false);
  });
});

describe('a Report whose job runs section is not a list of at most 1,000 entries', () => {
  test.each([
    ['a jobRuns that is not an object', 'runs'],
    ['a jobRuns that is null', null],
    ['a runs that is not an array', { runs: 'x' }],
    ['a jobRuns without runs', {}],
  ])('is invalid with %s', (_, jobRuns) => {
    expect(ReportSchema.safeParse(report({ jobRuns })).success).toBe(false);
  });

  test(`takes ${String(MAX_JOB_RUNS_PER_REPORT)} entries of any kind and refuses one more`, () => {
    expect(parsedRuns(nulls(MAX_JOB_RUNS_PER_REPORT)).success).toBe(true);
    expect(parsedRuns(nulls(MAX_JOB_RUNS_PER_REPORT + 1)).success).toBe(false);
  });

  test('keeps a run that breaks a rule for the Hub to judge', () => {
    const broken = { ...FAILED, exitStatus: 256 };

    expect(parsedRuns([broken, null]).data?.jobRuns).toEqual({ runs: [broken, null] });
  });
});
