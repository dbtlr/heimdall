import { describe, expect, test } from 'bun:test';

import { ReportSchema } from './report.ts';
import type { ServiceStopsSection } from './service-stops-section.ts';
import { sample } from './testing.ts';

const report = (extra: { serviceStops?: unknown } = {}) => ({
  collector: { arch: 'x64', platform: 'linux', version: '0.9.0' },
  samples: [sample(1_792_800_000_000)],
  schemaVersion: 1,
  sentAt: 1_792_800_015_000,
  system: 'server-1',
  ...extra,
});

const ENDED = {
  exitStatus: 3,
  ongoing: false,
  restarts: 1,
  result: 'exit-code',
  service: 'proxy',
  startedAt: 1_792_800_087_000,
  stoppedAt: 1_792_800_000_000,
};

describe('a Report', () => {
  test('carries Service stops, one ended and one still under way', () => {
    const serviceStops: ServiceStopsSection = {
      stops: [
        ENDED,
        {
          exitStatus: null,
          ongoing: true,
          restarts: 0,
          result: null,
          service: 'web',
          startedAt: null,
          stoppedAt: 1_792_800_010_000,
        },
      ],
    };

    expect(ReportSchema.parse(report({ serviceStops })).serviceStops).toEqual(serviceStops);
  });

  test('from a Collector that predates Service stops has none', () => {
    expect(ReportSchema.parse(report()).serviceStops).toBeUndefined();
  });

  test('takes a result only a newer systemd knows, since a result is any short word', () => {
    const stops = [{ ...ENDED, result: 'oom-kill-of-the-future' }];

    expect(ReportSchema.parse(report({ serviceStops: { stops } })).serviceStops).toEqual({ stops });
  });

  test.each([
    ['a negative restart count', { restarts: -1 }],
    ['a Service name the records refuse', { service: 'Not A Name' }],
    ['an empty result', { result: '' }],
  ])('refuses a stop with %s', (_, change) => {
    const parsed = ReportSchema.safeParse(
      report({ serviceStops: { stops: [{ ...ENDED, ...change }] } }),
    );

    expect(parsed.success).toBe(false);
  });
});
