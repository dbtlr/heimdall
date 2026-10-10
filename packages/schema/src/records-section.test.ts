import { describe, expect, test } from 'bun:test';

import { mirrorRecords, RecordsSectionSchema } from './records-section.ts';
import type { RecordRef, RecordsSection, SentRecord } from './records-section.ts';
import type { JobRecord, ServiceRecord } from './records.ts';
import { ReportSchema } from './report.ts';
import { sample } from './testing.ts';

const WEBAPP: ServiceRecord = { name: 'webapp', supervisor: 'systemd', unit: 'webapp.service' };
const BACKUP: JobRecord = {
  label: 'com.example.backup',
  name: 'backup',
  schedule: [{ hour: 3, minute: 30 }],
  scheduler: 'launchd',
};

const held = (records: SentRecord[], unreadable: RecordRef[] = []) => ({ records, unreadable });

const mirrored = (section: RecordsSection) => mirrorRecords(RecordsSectionSchema.parse(section));

const report = (records?: RecordsSection) => ({
  collector: { arch: 'arm64', platform: 'darwin', version: '0.4.0' },
  samples: [sample(1_759_700_000_000)],
  schemaVersion: 1,
  sentAt: 1_759_700_015_000,
  system: 'laptop-1',
  ...(records === undefined ? {} : { records }),
});

describe('a Report', () => {
  test('carries the record set the Collector holds', () => {
    const section = held([{ kind: 'service', name: 'webapp', record: WEBAPP }]);

    expect(ReportSchema.parse(report(section)).records).toEqual(section);
  });

  test('carries a marker in place of a set over budget', () => {
    expect(ReportSchema.parse(report({ overBudget: { bytes: 9_000_000 } })).records).toEqual({
      overBudget: { bytes: 9_000_000 },
    });
  });

  // Collectors send their set only when it changes (ADR-0011), and older ones never.
  test('parses without a record set', () => {
    expect(ReportSchema.parse(report()).records).toBeUndefined();
  });
});

describe('the records a Hub mirrors', () => {
  test('are the records the Collector sent, by kind and name', () => {
    expect(
      mirrored(
        held([
          { kind: 'service', name: 'webapp', record: WEBAPP },
          { kind: 'job', name: 'backup', record: BACKUP },
        ]),
      ),
    ).toEqual({
      records: [
        { kind: 'service', name: 'webapp', record: WEBAPP },
        { kind: 'job', name: 'backup', record: BACKUP },
      ],
      unreadable: [],
    });
  });

  test('keep the rows the Collector could not read', () => {
    expect(mirrored(held([], [{ kind: 'files', name: 'config' }]))).toEqual({
      records: [],
      unreadable: [{ kind: 'files', name: 'config' }],
    });
  });

  // ADR-0004: a field a newer Collector knows is dropped, and the record kept.
  test('drop fields this Hub does not know, at any depth', () => {
    const fromNewerCollector = {
      ...BACKUP,
      provenance: { by: 'my-provisioner', host: 'build-1' },
      retries: 2,
      schedule: [{ hour: 3, minute: 30, second: 0 }],
    };

    expect(mirrored(held([{ kind: 'job', name: 'backup', record: fromNewerCollector }]))).toEqual({
      records: [
        {
          kind: 'job',
          name: 'backup',
          record: { ...BACKUP, provenance: { by: 'my-provisioner' } },
        },
      ],
      unreadable: [],
    });
  });

  // A record this Hub cannot read still exists on the System, so a provisioner's
  // check must not report it missing.
  test.each([
    ['a kind this Hub does not know', { kind: 'volume', name: 'data', record: { name: 'data' } }],
    [
      'a supervisor this Hub does not know',
      { kind: 'service', name: 'webapp', record: { ...WEBAPP, supervisor: 'podman' } },
    ],
    [
      'a record whose name is not the one it is sent under',
      { kind: 'service', name: 'api', record: WEBAPP },
    ],
  ])('count %s as unreadable', (_case, entry) => {
    expect(mirrored(held([entry]))).toEqual({
      records: [],
      unreadable: [{ kind: entry.kind, name: entry.name }],
    });
  });

  test('keep the last of two records sent under one kind and name', () => {
    const moved = { ...WEBAPP, unit: 'webapp-2.service' };

    expect(
      mirrored(
        held([
          { kind: 'service', name: 'webapp', record: WEBAPP },
          { kind: 'service', name: 'webapp', record: moved },
        ]),
      ),
    ).toEqual({ records: [{ kind: 'service', name: 'webapp', record: moved }], unreadable: [] });
  });

  test('are unavailable when the set was over budget', () => {
    expect(mirrored({ overBudget: { bytes: 9_000_000 } })).toEqual({
      overBudget: { bytes: 9_000_000 },
    });
  });
});
