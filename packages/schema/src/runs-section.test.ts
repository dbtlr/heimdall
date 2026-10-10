import { describe, expect, test } from 'bun:test';

import type { RunRecord } from './records.ts';
import { ReportSchema } from './report.ts';
import { mirrorRuns, RunsSectionSchema } from './runs-section.ts';
import type { RunsSection } from './runs-section.ts';
import { sample } from './testing.ts';

const FAILED: RunRecord = {
  exitStatus: 1,
  finished: '2026-10-02T03:30:09Z',
  started: '2026-10-02T03:30:00Z',
};
const SUCCEEDED: RunRecord = {
  exitStatus: 0,
  finished: '2026-10-01T03:42:17Z',
  output: { file: 'backup-2026-10-01.tar.gz', sizeBytes: 73_400_320 },
  started: '2026-10-01T03:30:00Z',
};

const report = (extra: { runs?: RunsSection; timeZone?: string } = {}) => ({
  collector: { arch: 'arm64', platform: 'darwin', version: '0.4.0' },
  samples: [sample(1_759_700_000_000)],
  schemaVersion: 1,
  sentAt: 1_759_700_015_000,
  system: 'laptop-1',
  ...extra,
});

const mirrored = (section: RunsSection) => mirrorRuns(RunsSectionSchema.parse(section));

describe('a Report', () => {
  test("carries each job's latest run and latest success", () => {
    const runs = {
      jobs: [{ job: 'backup', latestRun: FAILED, latestSuccess: SUCCEEDED }],
      unreadable: [],
    };

    expect(ReportSchema.parse(report({ runs })).runs).toEqual(runs);
  });

  test('carries a marker in place of runs over budget', () => {
    expect(ReportSchema.parse(report({ runs: { overBudget: { bytes: 3_000_000 } } })).runs).toEqual(
      { overBudget: { bytes: 3_000_000 } },
    );
  });

  test.each(['America/New_York', 'UTC', 'Etc/GMT+5', 'America/Argentina/ComodRivadavia'])(
    'carries the time zone %s',
    (timeZone) => {
      expect(ReportSchema.parse(report({ timeZone })).timeZone).toBe(timeZone);
    },
  );

  test.each(['', 'America/New York', 'Europe/Paris\n', 'x'.repeat(65)])(
    'drops %j as a time zone, and the Report still parses',
    (timeZone) => {
      const parsed = ReportSchema.safeParse(report({ timeZone }));

      expect(parsed.success).toBe(true);
      expect(parsed.data?.timeZone).toBeUndefined();
    },
  );

  // Collectors that predate HMD-37 send neither.
  test('parses without runs or a time zone', () => {
    const parsed = ReportSchema.parse(report());

    expect(parsed.runs).toBeUndefined();
    expect(parsed.timeZone).toBeUndefined();
  });
});

describe('the runs a Hub mirrors', () => {
  test("are each job's latest run and latest success", () => {
    expect(
      mirrored({
        jobs: [
          { job: 'backup', latestRun: FAILED, latestSuccess: SUCCEEDED },
          { job: 'rotate', latestRun: FAILED, latestSuccess: null },
        ],
        unreadable: ['sync'],
      }),
    ).toEqual({
      jobs: [
        { job: 'backup', latestRun: FAILED, latestSuccess: SUCCEEDED },
        { job: 'rotate', latestRun: FAILED, latestSuccess: null },
      ],
      unreadable: ['sync'],
    });
  });

  // ADR-0004: a field a newer Collector knows is dropped, and the run kept.
  test('drop fields this Hub does not know, at any depth', () => {
    const fromNewerCollector = {
      ...SUCCEEDED,
      durationMs: 737_000,
      output: { ...SUCCEEDED.output, sha256: 'ab' },
    };

    expect(
      mirrored({
        jobs: [{ job: 'backup', latestRun: fromNewerCollector, latestSuccess: fromNewerCollector }],
        unreadable: [],
      }),
    ).toEqual({
      jobs: [{ job: 'backup', latestRun: SUCCEEDED, latestSuccess: SUCCEEDED }],
      unreadable: [],
    });
  });

  // The job still ran; its runs exist on the System in a shape this Hub cannot read.
  test.each([
    ['a latest run', { latestRun: { ...FAILED, exitStatus: 300 }, latestSuccess: SUCCEEDED }],
    ['a latest success', { latestRun: FAILED, latestSuccess: { started: 'yesterday' } }],
  ])('count a job whose %s does not read as unreadable', (_case, runs) => {
    expect(mirrored({ jobs: [{ job: 'backup', ...runs }], unreadable: [] })).toEqual({
      jobs: [],
      unreadable: ['backup'],
    });
  });

  test('keep the last of two entries for one job', () => {
    expect(
      mirrored({
        jobs: [
          { job: 'backup', latestRun: SUCCEEDED, latestSuccess: SUCCEEDED },
          { job: 'backup', latestRun: FAILED, latestSuccess: SUCCEEDED },
        ],
        unreadable: [],
      }),
    ).toEqual({
      jobs: [{ job: 'backup', latestRun: FAILED, latestSuccess: SUCCEEDED }],
      unreadable: [],
    });
  });

  test('never list a job as unreadable that they also hold', () => {
    expect(
      mirrored({
        jobs: [{ job: 'backup', latestRun: FAILED, latestSuccess: null }],
        unreadable: ['backup', 'sync', 'sync'],
      }),
    ).toEqual({
      jobs: [{ job: 'backup', latestRun: FAILED, latestSuccess: null }],
      unreadable: ['sync'],
    });
  });

  test('are unavailable when the runs were over budget', () => {
    expect(mirrored({ overBudget: { bytes: 3_000_000 } })).toEqual({
      overBudget: { bytes: 3_000_000 },
    });
  });
});
