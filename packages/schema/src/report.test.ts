import { describe, expect, test } from 'bun:test';

import { ReportSchema } from './report.ts';
import type { Report } from './report.ts';
import { sample } from './testing.ts';

const report = (): Report => ({
  collector: { arch: 'arm64', platform: 'darwin', version: '0.1.0' },
  samples: [sample(1_759_700_000_000), sample(1_759_700_015_000)],
  schemaVersion: 1,
  sentAt: 1_759_700_030_000,
  system: 'db-mbp',
});

describe('a Report', () => {
  test('parses when complete', () => {
    expect(ReportSchema.safeParse(report())).toEqual({ data: report(), success: true });
  });

  // A newer Collector may carry sections this Hub predates (ADR-0004).
  test('drops fields it does not know instead of rejecting them', () => {
    const fromNewerCollector = {
      ...report(),
      collector: { ...report().collector, build: 'abc123' },
      samples: [
        {
          ...sample(1_759_700_000_000),
          disks: [{ ...sample(0).disks[0], fsType: 'apfs' }],
          swap: { usedBytes: 0 },
        },
      ],
      sessions: [{ harness: 'claude' }],
    };

    expect(ReportSchema.parse(fromNewerCollector)).toEqual({
      ...report(),
      samples: [sample(1_759_700_000_000)],
    });
  });

  test('accepts 1000 samples', () => {
    const samples = Array.from({ length: 1000 }, (_, i) => sample(1_759_700_000_000 + i * 15_000));

    expect(ReportSchema.safeParse({ ...report(), samples }).success).toBe(true);
  });

  // Values operating systems produce in normal operation; rejecting them would
  // discard a whole batch of good samples.
  test.each([
    [
      'memory used above total while macOS compresses',
      { memory: { totalBytes: 34_359_738_368, usedBytes: 35e9 } },
    ],
    [
      'disk used above total while a volume resizes',
      { disks: [{ mount: '/', totalBytes: 1, usedBytes: 2 }] },
    ],
    ['System CPU just over 100 from timer jitter', { cpu: { busyPercent: 100.2 } }],
    [
      'Collector CPU just over 100 from timer jitter',
      { collector: { cpuPercent: 100.3, rssBytes: 41_943_040 } },
    ],
  ])('tolerates %s', (_, override) => {
    const samples = [{ ...sample(1_759_700_000_000), ...override }];

    expect(ReportSchema.safeParse({ ...report(), samples }).success).toBe(true);
  });

  test('tolerates samples later than sentAt from a clock adjustment', () => {
    expect(ReportSchema.safeParse({ ...report(), sentAt: 1_759_699_990_000 }).success).toBe(true);
  });
});

describe('a Report is rejected', () => {
  const withSample = (override: object) => ({
    ...report(),
    samples: [{ ...sample(1_759_700_000_000), ...override }],
  });

  const { uptimeSeconds: _omitted, ...withoutUptime } = sample(1_759_700_000_000);

  test.each([
    ['from an unknown schema version', { ...report(), schemaVersion: 2 }],
    ['naming a System outside Fleet names', { ...report(), system: 'DB_MBP' }],
    ['naming a System with a trailing hyphen', { ...report(), system: 'db-' }],
    [
      'from an unsupported platform',
      { ...report(), collector: { ...report().collector, platform: 'win32' } },
    ],
    ['with no samples', { ...report(), samples: [] }],
    [
      'with 1001 samples',
      {
        ...report(),
        samples: Array.from({ length: 1001 }, (_, i) => sample(1_759_700_000_000 + i)),
      },
    ],
    [
      'with a repeated sample time',
      { ...report(), samples: [sample(1_759_700_000_000), sample(1_759_700_000_000)] },
    ],
    [
      'with sample times out of order',
      { ...report(), samples: [sample(1_759_700_015_000), sample(1_759_700_000_000)] },
    ],
    ['with a fractional sample time', withSample({ t: 1_759_700_000_000.5 })],
    ['with no disks', withSample({ disks: [] })],
    ['with negative CPU', withSample({ cpu: { busyPercent: -1 } })],
    [
      'with fractional memory bytes',
      withSample({ memory: { totalBytes: 34_359_738_368, usedBytes: 1.5 } }),
    ],
    [
      'with negative disk bytes',
      withSample({ disks: [{ mount: '/', totalBytes: 1, usedBytes: -1 }] }),
    ],
    ['with negative load', withSample({ load: [-0.1, 0.9, 0.7] })],
    [
      'with fractional Collector memory',
      withSample({ collector: { cpuPercent: 0.4, rssBytes: 0.5 } }),
    ],
    ['with a sample missing a field', { ...report(), samples: [withoutUptime] }],
    ['with an infinite CPU reading', withSample({ cpu: { busyPercent: Infinity } })],
    ['with a NaN load', withSample({ load: [Number.NaN, 0.9, 0.7] })],
    ['with infinite memory bytes', withSample({ memory: { totalBytes: Infinity, usedBytes: 1 } })],
    ['with a sample time beyond safe integers', withSample({ t: 2 ** 53 })],
    ['with a sample time past the last a Date can hold', withSample({ t: 8_640_000_000_000_001 })],
  ])('%s', (_, input) => {
    expect(ReportSchema.safeParse(input).success).toBe(false);
  });
});
