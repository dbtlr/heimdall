import { describe, expect, test } from 'bun:test';

import { ChecksSectionSchema, mirrorChecks } from './checks-section.ts';
import type { ChecksSection } from './checks-section.ts';
import { ReportSchema } from './report.ts';
import { sample } from './testing.ts';

const report = (extra: { checks?: ChecksSection } = {}) => ({
  collector: { arch: 'arm64', platform: 'darwin', version: '0.4.0' },
  samples: [sample(1_759_700_000_000)],
  schemaVersion: 1,
  sentAt: 1_759_700_015_000,
  system: 'laptop-1',
  ...extra,
});

const DRIFTED = {
  path: '/etc/webapp/webapp.conf',
  record: 'webapp-config',
  since: 1_759_690_000_000,
  state: 'drifted',
} as const;

const mirrored = (section: ChecksSection) => mirrorChecks(ChecksSectionSchema.parse(section));

describe('a Report', () => {
  test('carries the files that do not match their records', () => {
    const checks = { files: [DRIFTED, { ...DRIFTED, path: '/etc/webapp/b', state: 'missing' }] };

    expect(ReportSchema.parse(report({ checks })).checks).toEqual(checks);
  });

  test('carries an empty list when every file matches', () => {
    expect(ReportSchema.parse(report({ checks: { files: [] } })).checks).toEqual({ files: [] });
  });

  test('carries a marker in place of checks over budget', () => {
    const checks = { overBudget: { bytes: 2_000_000 } };

    expect(ReportSchema.parse(report({ checks })).checks).toEqual(checks);
  });

  test('parses without checks, as a Collector that predates them sends it', () => {
    expect(ReportSchema.parse(report()).checks).toBeUndefined();
  });

  test('drops a part only a newer Collector knows, and keeps the rest', () => {
    const parsed = ReportSchema.parse(
      report({
        checks: { files: [], services: [{ name: 'web', state: 'down' }] } as ChecksSection,
      }),
    );

    expect(parsed.checks).toEqual({ files: [] });
  });

  test.each([
    ['a relative record name', { ...DRIFTED, record: '../x' }],
    ['an empty path', { ...DRIFTED, path: '' }],
    ['a negative since', { ...DRIFTED, since: -1 }],
  ])('refuses %s', (_, entry) => {
    expect(ReportSchema.safeParse(report({ checks: { files: [entry] } })).success).toBe(false);
  });
});

describe('the checks a Hub mirrors', () => {
  test('are the files that do not match', () => {
    expect(mirrored({ files: [DRIFTED] })).toEqual({ files: [DRIFTED] });
  });

  test('count a state only a newer Collector knows as unreadable, so the file is not taken for clean', () => {
    expect(mirrored({ files: [{ ...DRIFTED, state: 'sparkling' }] })).toEqual({
      files: [{ ...DRIFTED, state: 'unreadable' }],
    });
  });

  test('keep the last of a file sent twice under one record', () => {
    expect(
      mirrored({ files: [DRIFTED, { ...DRIFTED, since: 1_759_691_000_000, state: 'missing' }] }),
    ).toEqual({ files: [{ ...DRIFTED, since: 1_759_691_000_000, state: 'missing' }] });
  });

  test('keep the size of checks too large to send', () => {
    expect(mirrored({ overBudget: { bytes: 2_000_000 } })).toEqual({
      overBudget: { bytes: 2_000_000 },
    });
  });
});
