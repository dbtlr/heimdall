import { describe, expect, test } from 'bun:test';

import { HarnessesSectionSchema, MAX_HARNESS_INSTALLS } from './harnesses-section.ts';
import { ReportSchema } from './report.ts';
import { sample } from './testing.ts';

const install = { harness: 'claude-code', location: 'mise', version: '2.1.296' };

const report = (extra: object = {}) => ({
  collector: { arch: 'arm64', platform: 'darwin', version: '0.5.0' },
  samples: [sample(1_759_700_000_000)],
  schemaVersion: 1,
  sentAt: 1_759_700_015_000,
  system: 'laptop-1',
  ...extra,
});

describe('a Report', () => {
  test('carries the Harness installs the Collector found', () => {
    const harnesses = { installs: [install, { ...install, harness: 'codex', location: 'npm' }] };

    expect(ReportSchema.parse(report({ harnesses })).harnesses).toEqual(harnesses);
  });

  test('is still valid from a Collector that predates the section', () => {
    expect(ReportSchema.parse(report()).harnesses).toBeUndefined();
  });
});

describe('the harnesses section', () => {
  test('takes a Harness and a location kind this Hub does not know (ADR-0004)', () => {
    const newer = { harness: 'gemini-cli', location: 'nix', version: '0.63.0' };

    expect(HarnessesSectionSchema.parse({ installs: [newer] }).installs).toEqual([newer]);
  });

  test.each([
    ['an empty version', { ...install, version: '' }],
    ['a version over 64 characters', { ...install, version: '1'.repeat(65) }],
  ])('refuses %s', (_, bad) => {
    expect(HarnessesSectionSchema.safeParse({ installs: [bad] }).success).toBe(false);
  });

  test('refuses more installs than the budget', () => {
    const installs = Array.from({ length: MAX_HARNESS_INSTALLS + 1 }, (_, i) => ({
      ...install,
      version: `1.0.${String(i)}`,
    }));

    expect(HarnessesSectionSchema.safeParse({ installs }).success).toBe(false);
  });
});
