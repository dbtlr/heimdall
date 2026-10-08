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

  test('parses when its latest run is its latest success', () => {
    const succeeded = { ...runRecord(), latestRun: success, latestSuccess: success };

    expect(parsedRecord(succeeded)).toEqual(succeeded);
  });

  test('parses a run that finished within the second it started', () => {
    const quick = { ...runRecord(), latestRun: { ...latestRun, finishedAt: latestRun.startedAt } };

    expect(parsedRecord(quick)).toEqual(quick);
  });

  // Fleet and each Collector upgrade on their own schedules, so a Collector
  // reading a newer Fleet's record keeps what it knows (ADR-0010).
  test.each([
    ['the record', { ...runRecord(), host: 'laptop-1' }],
    ['its latest run', { ...runRecord(), latestRun: { ...latestRun, pid: 4242 } }],
    ['its latest success', { ...runRecord(), latestSuccess: { ...success, pid: 4242 } }],
    [
      'an archive',
      {
        ...runRecord(),
        latestSuccess: { ...success, archive: { ...success.archive, sha256: 'ab' } },
      },
    ],
  ])('from a newer Fleet parses without fields on %s this Collector does not know', (_, input) => {
    expect(parsedRecord(input)).toEqual(runRecord());
  });

  test('of an unknown schema version is refused as unknown', () => {
    expect(parseRunRecord({ ...runRecord(), schemaVersion: 2 })).toEqual({
      kind: 'unknown-version',
      schemaVersion: 2,
    });
  });
});

describe('a run record is invalid', () => {
  test.each<[string, unknown]>([
    ['with no latest run', { ...runRecord(), latestRun: null }],
    // The runner records a success in both places, so the two cannot disagree.
    [
      'with a successful latest run that is not its latest success',
      { ...runRecord(), latestRun: { ...success, finishedAt: '2026-10-08T07:15:05Z' } },
    ],
    [
      'with a successful latest run and no success',
      { ...runRecord(), latestRun: success, latestSuccess: null },
    ],
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
      'with a run time finer than a second',
      { ...runRecord(), latestRun: { ...latestRun, startedAt: '2026-10-08T19:15:00.5Z' } },
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
    ...['..', '.', '', 'notes\u0000.sqlite', `${'n'.repeat(252)}.sqlite`].map(
      (name): [string, unknown] => [
        `with an archive named ${JSON.stringify(name.length > 20 ? `${name.slice(0, 8)}…` : name)}`,
        { ...runRecord(), latestSuccess: { ...success, archive: { name, sizeBytes: 1 } } },
      ],
    ),
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
