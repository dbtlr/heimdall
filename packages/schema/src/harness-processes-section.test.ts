import { describe, expect, test } from 'bun:test';

import {
  HarnessProcessesSectionSchema,
  MAX_HARNESS_PROCESSES,
} from './harness-processes-section.ts';
import { ReportSchema } from './report.ts';
import { sample } from './testing.ts';

const running = {
  cpuMicros: 12_500_000,
  cwd: '/work/project',
  harness: 'claude-code',
  lastSeenAt: 1_759_700_010_000,
  peakRssBytes: 600_000_000,
  pid: 4242,
  rssBytes: 500_000_000,
  startedAt: 1_759_690_000_000,
};
const ended = { ...running, endedAt: 1_759_700_010_000, pid: 4243 };

const report = (extra: object = {}) => ({
  collector: { arch: 'x64', platform: 'linux', version: '0.5.0' },
  samples: [sample(1_759_700_000_000)],
  schemaVersion: 1,
  sentAt: 1_759_700_015_000,
  system: 'server-1',
  ...extra,
});

describe('a Report', () => {
  test('carries the Harness processes running and the ones that ended', () => {
    const harnessProcesses = { processes: [running, ended] };

    expect(ReportSchema.parse(report({ harnessProcesses })).harnessProcesses).toEqual(
      harnessProcesses,
    );
  });

  test('is still valid from a Collector that predates the section', () => {
    expect(ReportSchema.parse(report()).harnessProcesses).toBeUndefined();
  });
});

describe('the harnessProcesses section', () => {
  test('takes a process whose working directory the Collector could not read', () => {
    const parsed = HarnessProcessesSectionSchema.parse({ processes: [{ ...running, cwd: null }] });

    expect(parsed.processes[0]?.cwd).toBeNull();
  });

  test('repository is a path, null, or absent', () => {
    const parsed = HarnessProcessesSectionSchema.parse({
      processes: [
        { ...running, repository: '/work/project' },
        { ...running, pid: 4244, repository: null },
        running,
      ],
    });

    expect(parsed.processes.map((p) => p.repository)).toEqual(['/work/project', null, undefined]);
  });

  test('takes a Harness this Hub does not know (ADR-0004)', () => {
    expect(
      HarnessProcessesSectionSchema.safeParse({
        processes: [{ ...running, harness: 'gemini-cli' }],
      }).success,
    ).toBe(true);
  });

  test('does not pass on fields it does not define, so no argument text can ride along', () => {
    const parsed = HarnessProcessesSectionSchema.parse({
      processes: [{ ...running, args: ['--secret'], environ: 'TOKEN=x' }],
    });

    expect(JSON.stringify(parsed)).not.toMatch(/secret|TOKEN/u);
  });

  test.each([
    ['pid 0', { ...running, pid: 0 }],
    ['a negative CPU time', { ...running, cpuMicros: -1 }],
    ['a working directory over 4096 bytes', { ...running, cwd: '/'.repeat(4097) }],
  ])('refuses %s', (_, bad) => {
    expect(HarnessProcessesSectionSchema.safeParse({ processes: [bad] }).success).toBe(false);
  });

  test('refuses more processes than the budget', () => {
    const processes = Array.from({ length: MAX_HARNESS_PROCESSES + 1 }, (_, i) => ({
      ...running,
      pid: i + 1,
    }));

    expect(HarnessProcessesSectionSchema.safeParse({ processes }).success).toBe(false);
  });
});
