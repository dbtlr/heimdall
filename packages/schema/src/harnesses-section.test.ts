import { describe, expect, test } from 'bun:test';

import {
  HarnessesSectionSchema,
  MAX_HARNESS_INSTALLS,
  UNKNOWN_HARNESS_VERSION,
} from './harnesses-section.ts';
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

  test('carries an empty list when no Harness is installed', () => {
    expect(ReportSchema.parse(report({ harnesses: { installs: [] } })).harnesses).toEqual({
      installs: [],
    });
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

  test('takes the unknown version of an install whose version could not be read', () => {
    expect(UNKNOWN_HARNESS_VERSION).toBe('unknown');
    expect(
      HarnessesSectionSchema.safeParse({
        installs: [{ ...install, version: UNKNOWN_HARNESS_VERSION }],
      }).success,
    ).toBe(true);
  });

  test.each([
    ['an empty version', { ...install, version: '' }],
    ['a version over 64 characters', { ...install, version: '1'.repeat(65) }],
    ['a Harness over 64 characters', { ...install, harness: 'h'.repeat(65) }],
    ['a location over 64 characters', { ...install, location: 'l'.repeat(65) }],
    ['an empty Harness', { ...install, harness: '' }],
    ['an empty location', { ...install, location: '' }],
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
