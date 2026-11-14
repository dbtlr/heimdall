import { describe, expect, test } from 'bun:test';

import { MAX_JOB_RUNS_PER_REPORT } from './job-runs-section.ts';
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

// `count` runs of one job, a second apart, oldest first.
const runsOfOneJob = (count: number): SentJobRun[] =>
  Array.from({ length: count }, (_, index) => {
    const started = new Date(Date.parse(SUCCEEDED.started) + index * 1000)
      .toISOString()
      .replace('.000Z', 'Z');
    return { exitStatus: 0, finished: started, job: 'rotate-logs', started };
  });

const parsedRuns = (runs: unknown[]) => ReportSchema.safeParse(report({ jobRuns: { runs } }));

describe('a Report', () => {
  test('carries job runs oldest first, with and without an output file', () => {
    const jobRuns: JobRunsSection = {
      runs: [SUCCEEDED, FAILED, { ...FAILED, job: 'rotate-logs' }],
    };

    expect(ReportSchema.parse(report({ jobRuns })).jobRuns).toEqual(jobRuns);
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

    expect(ReportSchema.parse(report({ jobRuns: { runs: [fromNewerCollector] } })).jobRuns).toEqual(
      { runs: [SUCCEEDED] },
    );
  });

  test('refuses two runs with the same job and start, even with different details', () => {
    const parsed = parsedRuns([FAILED, { ...FAILED, exitStatus: 0 }]);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toContainEqual(
      expect.objectContaining({ message: 'duplicate job run', path: ['jobRuns', 'runs'] }),
    );
  });

  test('accepts another run of the same job and another job started at the same time', () => {
    const runs = [SUCCEEDED, FAILED, { ...FAILED, job: 'rotate-logs' }];

    expect(parsedRuns(runs).data?.jobRuns).toEqual({ runs });
  });

  // The Collector sends the oldest first, which the Hub does not check.
  test('accepts runs in any order', () => {
    const runs = [FAILED, SUCCEEDED];

    expect(parsedRuns(runs).data?.jobRuns).toEqual({ runs });
  });

  // The Hub stores every time the section accepts, including years PostgreSQL
  // does not parse as text, so a run from a broken clock never fails a Report.
  test.each([
    ['the first second of year 0000', '0000-01-01T00:00:00Z'],
    ['the last second of year 9999', '9999-12-31T23:59:59Z'],
  ])('accepts a run started at %s', (_, time) => {
    const run = { ...FAILED, finished: time, started: time };

    expect(parsedRuns([run]).data?.jobRuns).toEqual({ runs: [run] });
  });

  test(`accepts ${String(MAX_JOB_RUNS_PER_REPORT)} runs and refuses one more`, () => {
    expect(parsedRuns(runsOfOneJob(MAX_JOB_RUNS_PER_REPORT)).success).toBe(true);
    expect(parsedRuns(runsOfOneJob(MAX_JOB_RUNS_PER_REPORT + 1)).success).toBe(false);
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
  ])('refuses a run with %s', (_, change) => {
    expect(parsedRuns([{ ...FAILED, ...change }]).success).toBe(false);
  });
});
