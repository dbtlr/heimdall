import { describe, expect, test } from 'bun:test';

import { ChecksSectionSchema, filesRecordDigest, mirrorChecks } from './checks-section.ts';
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

// A Service's supervisor check that passes, as the Collector sends it.
const WEB_UP = {
  check: 'supervisor',
  detail: 'ActiveState=active',
  service: 'web',
  since: 1_759_690_000_000,
  state: 'up',
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

  test('carries a marker in place of each part over budget, beside the parts that fit', () => {
    const checks = {
      overBudget: { files: { bytes: 2_000_000 } },
      services: [WEB_UP],
    };

    expect(ReportSchema.parse(report({ checks })).checks).toEqual(checks);
  });

  test('parses without checks, as a Collector that predates them sends it', () => {
    expect(ReportSchema.parse(report()).checks).toBeUndefined();
  });

  test('drops a part only a newer Collector knows, and keeps the rest', () => {
    const parsed = ReportSchema.parse(
      report({
        checks: { certificates: [{ name: 'web', state: 'expired' }], files: [] } as ChecksSection,
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
    expect(mirrored({ files: [DRIFTED] })).toMatchObject({ fileRecords: [], files: [DRIFTED] });
  });

  test('count a state only a newer Collector knows as unreadable, so the file is not taken for clean', () => {
    expect(mirrored({ files: [{ ...DRIFTED, state: 'sparkling' }] })).toMatchObject({
      fileRecords: [],
      files: [{ ...DRIFTED, state: 'unreadable' }],
    });
  });

  test('keep the last of a file sent twice under one record', () => {
    expect(
      mirrored({ files: [DRIFTED, { ...DRIFTED, since: 1_759_691_000_000, state: 'missing' }] }),
    ).toMatchObject({
      fileRecords: [],
      files: [{ ...DRIFTED, since: 1_759_691_000_000, state: 'missing' }],
    });
  });

  test('keep the size of a files part too large to send, and none of its files', () => {
    expect(
      mirrored({ files: [DRIFTED], overBudget: { files: { bytes: 2_000_000 } } }),
    ).toMatchObject({ fileRecords: null, files: null, filesOverBudgetBytes: 2_000_000 });
  });
});

describe('a files record digest', () => {
  const A = { path: '/etc/a', sha256: 'a'.repeat(64) };
  const B = { path: '/etc/b', sha256: 'b'.repeat(64) };

  // From sha256sum over "/etc/a\0<a's hash>\n/etc/b\0<b's hash>\n".
  test('is the SHA-256 of the files as path, NUL, hash, newline lines in path order', async () => {
    expect(await filesRecordDigest({ files: [A, B] })).toBe(
      '226e294b986bd39fdfe1a31df234c45c9469895494cc1e1cfdae5a538a09976d',
    );
  });

  test('does not depend on the order the files are listed in', async () => {
    expect(await filesRecordDigest({ files: [B, A] })).toBe(
      await filesRecordDigest({ files: [A, B] }),
    );
  });

  test('orders paths by code unit, not by locale', async () => {
    const upper = { path: '/etc/B', sha256: 'c'.repeat(64) };
    const lower = { path: '/etc/a', sha256: 'd'.repeat(64) };

    expect(await filesRecordDigest({ files: [lower, upper] })).toBe(
      new Bun.CryptoHasher('sha256')
        .update(`/etc/B\0${upper.sha256}\n/etc/a\0${lower.sha256}\n`)
        .digest('hex'),
    );
  });

  test('changes with a path or a hash', async () => {
    const digest = await filesRecordDigest({ files: [A, B] });

    expect(await filesRecordDigest({ files: [A, { ...B, sha256: 'c'.repeat(64) }] })).not.toBe(
      digest,
    );
    expect(await filesRecordDigest({ files: [A, { ...B, path: '/etc/c' }] })).not.toBe(digest);
    expect(await filesRecordDigest({ files: [A] })).not.toBe(digest);
  });
});

describe('the parts of a checks section', () => {
  test('are all optional, so a section a newer Collector sends with other parts still parses', () => {
    expect(ReportSchema.parse(report({ checks: {} })).checks).toEqual({});
    expect(
      ReportSchema.parse(report({ checks: { certificates: [{ name: 'web' }] } as ChecksSection }))
        .checks,
    ).toEqual({});
  });

  test('list the files records the Collector hashed, beside the files that do not match', () => {
    const checks = {
      fileRecords: [{ digest: 'f'.repeat(64), record: 'webapp-config' }],
      files: [DRIFTED],
    };

    expect(ReportSchema.parse(report({ checks })).checks).toEqual(checks);
  });

  test('mirror as an absent files part, not an empty one, when the section has none', () => {
    expect(mirrored({})).toMatchObject({ fileRecords: null, files: null });
    expect(mirrored({ files: [] })).toMatchObject({ fileRecords: [], files: [] });
  });

  test('keep the last digest of a record sent twice', () => {
    expect(
      mirrored({
        fileRecords: [
          { digest: '1'.repeat(64), record: 'a' },
          { digest: '2'.repeat(64), record: 'a' },
        ],
        files: [],
      }),
    ).toMatchObject({ fileRecords: [{ digest: '2'.repeat(64), record: 'a' }], files: [] });
  });

  test('judge no record when the section lists hashed records but carries no files part', () => {
    expect(mirrored({ fileRecords: [{ digest: '1'.repeat(64), record: 'a' }] })).toMatchObject({
      fileRecords: null,
      files: null,
    });
  });

  test.each([
    ['a digest that is not hexadecimal', { digest: 'xyz', record: 'a' }],
    ['a record name with a slash', { digest: 'f'.repeat(64), record: 'a/b' }],
  ])('refuse %s', (_, entry) => {
    expect(ReportSchema.safeParse(report({ checks: { fileRecords: [entry] } })).success).toBe(
      false,
    );
  });
});

describe('the services part of a checks section', () => {
  test('lists each Service check with its state, detail, and since', () => {
    const checks = { services: [WEB_UP, { ...WEB_UP, service: 'db', state: 'stopped' }] };

    expect(ReportSchema.parse(report({ checks })).checks).toEqual(checks);
  });

  test('carries an empty list when no Service is recorded', () => {
    expect(ReportSchema.parse(report({ checks: { services: [] } })).checks).toEqual({
      services: [],
    });
  });

  test.each([
    ['a service name with a slash', { ...WEB_UP, service: 'a/b' }],
    ['an empty check', { ...WEB_UP, check: '' }],
    ['an empty state', { ...WEB_UP, state: '' }],
    ['a negative since', { ...WEB_UP, since: -1 }],
    ['a detail of a thousand characters', { ...WEB_UP, detail: 'x'.repeat(1000) }],
  ])('refuses %s', (_, entry) => {
    expect(ReportSchema.safeParse(report({ checks: { services: [entry] } })).success).toBe(false);
  });

  test('mirror as the checks sent, and as none at all when the section has no services part', () => {
    expect(mirrored({ services: [WEB_UP] }).services).toEqual([WEB_UP]);
    expect(mirrored({ files: [] }).services).toBeNull();
  });

  test('count a state only a newer Collector knows as unknown, so the Service is not taken for up', () => {
    expect(mirrored({ services: [{ ...WEB_UP, state: 'sparkling' }] }).services).toEqual([
      { ...WEB_UP, state: 'unknown' },
    ]);
  });

  test('mirror a health check and its unhealthy state as sent, beside the supervisor check', () => {
    const health = { ...WEB_UP, check: 'health', detail: 'HTTP 503', state: 'unhealthy' } as const;

    expect(mirrored({ services: [WEB_UP, health] }).services).toEqual([WEB_UP, health]);
  });

  test('drop a check only a newer Collector knows', () => {
    expect(mirrored({ services: [{ ...WEB_UP, check: 'tls' }, WEB_UP] }).services).toEqual([
      WEB_UP,
    ]);
  });

  test('keep the last of a check sent twice for one Service', () => {
    const later = { ...WEB_UP, since: 1_759_691_000_000, state: 'stopped' } as const;

    expect(mirrored({ services: [WEB_UP, later] }).services).toEqual([later]);
  });

  test('keep the size of a services part too large to send, and none of its checks', () => {
    expect(
      mirrored({ overBudget: { services: { bytes: 2_000_000 } }, services: [WEB_UP] }),
    ).toMatchObject({ services: null, servicesOverBudgetBytes: 2_000_000 });
  });

  test('over budget in the files part leaves the services part as sent', () => {
    expect(
      mirrored({ overBudget: { files: { bytes: 2_000_000 } }, services: [WEB_UP] }),
    ).toMatchObject({ filesOverBudgetBytes: 2_000_000, services: [WEB_UP] });
  });
});
