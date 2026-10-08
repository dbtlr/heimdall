import { describe, expect, test } from 'bun:test';

import { parseRunRecord } from './run-record.ts';
import { runRecord } from './testing.ts';

const parsedRecord = (input: unknown): unknown => {
  const parsed = parseRunRecord(input);
  return parsed.kind === 'parsed' ? parsed.value : parsed;
};

const { latestRun, latestSuccess } = runRecord();
const success = latestSuccess ?? latestRun;

describe('a run record', () => {
  test('parses with a failed latest run and an earlier success', () => {
    expect(parsedRecord(runRecord())).toEqual(runRecord());
  });

  test('parses before the Backup Job has ever succeeded', () => {
    const neverSucceeded = { ...runRecord(), latestSuccess: null };

    expect(parsedRecord(neverSucceeded)).toEqual(neverSucceeded);
  });

  test('from a newer Fleet parses without the fields this Collector does not know', () => {
    expect(parsedRecord({ ...runRecord(), host: 'laptop-1' })).toEqual(runRecord());
  });

  test('of an unknown schema version is refused as unknown', () => {
    expect(parseRunRecord({ ...runRecord(), schemaVersion: 2 })).toEqual({
      kind: 'unknown-version',
      schemaVersion: 2,
    });
  });
});

describe('a run record is invalid', () => {
  test.each([
    ['with no latest run', { ...runRecord(), latestRun: null }],
    [
      'with a success that exited nonzero',
      { ...runRecord(), latestSuccess: { ...success, exitStatus: 1 } },
    ],
    [
      'with a success that wrote no archive',
      { ...runRecord(), latestSuccess: { ...success, archive: null } },
    ],
    [
      'with an exit status out of range',
      { ...runRecord(), latestRun: { ...latestRun, exitStatus: 256 } },
    ],
    [
      'with a run that finished before it started',
      { ...runRecord(), latestRun: { ...latestRun, finishedAt: '2026-10-08T19:14:59Z' } },
    ],
    [
      'with a run time not in UTC',
      { ...runRecord(), latestRun: { ...latestRun, startedAt: '2026-10-08T15:15:00-04:00' } },
    ],
    [
      'with an archive outside its destination',
      {
        ...runRecord(),
        latestSuccess: { ...success, archive: { name: '../notes.sqlite', sizeBytes: 1 } },
      },
    ],
    [
      'with an archive of negative size',
      {
        ...runRecord(),
        latestSuccess: { ...success, archive: { name: 'notes.sqlite', sizeBytes: -1 } },
      },
    ],
    ['naming outside Fleet names', { ...runRecord(), name: 'Notes' }],
  ])('%s', (_, input) => {
    expect(parseRunRecord(input).kind).toBe('invalid');
  });
});
