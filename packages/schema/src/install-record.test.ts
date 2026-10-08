import { describe, expect, test } from 'bun:test';

import { parseInstallRecord } from './install-record.ts';
import { applicationInstall, backupJobInstall, serviceInstall } from './testing.ts';

const parsedRecord = (input: unknown): unknown => {
  const parsed = parseInstallRecord(input);
  return parsed.kind === 'parsed' ? parsed.value : parsed;
};

describe('an install record', () => {
  test('of an Application parses when complete', () => {
    expect(parsedRecord(applicationInstall())).toEqual(applicationInstall());
  });

  test('of a systemd Service parses with its unit and health check', () => {
    expect(parsedRecord(serviceInstall())).toEqual(serviceInstall());
  });

  // What Fleet records of every install, for building Services by supervisor.
  const { commit, installedAt, schemaVersion } = applicationInstall();
  const installed = { commit, installedAt, kind: 'service', name: 'notes', schemaVersion };

  test('of a docker Service names its container', () => {
    const docker = { ...installed, container: 'fleet-notes', supervisor: 'docker' };

    expect(parsedRecord(docker)).toEqual(docker);
  });

  // A native Service's Application names its own unit, so Fleet records none.
  test('of a native Service needs no unit or container', () => {
    const native = { ...installed, healthUrl: 'http://127.0.0.1:8080/', supervisor: 'native' };

    expect(parsedRecord(native)).toEqual(native);
  });

  test('of a Backup Job parses with its launchd label, schedule, and destination', () => {
    expect(parsedRecord(backupJobInstall())).toEqual(backupJobInstall());
  });
});

// Fleet and each Collector upgrade on their own schedules, so a Collector
// reading a newer Fleet's record keeps what it knows (ADR-0010).
describe('an install record from a newer Fleet', () => {
  const { commit, installedAt, schemaVersion } = applicationInstall();
  const installed = { commit, installedAt, kind: 'service', name: 'notes', schemaVersion };
  const backupJob = backupJobInstall();

  test.each([
    ['an Application', applicationInstall()],
    ['a systemd Service', serviceInstall()],
    ['a docker Service', { ...installed, container: 'fleet-notes', supervisor: 'docker' }],
    ['a native Service', { ...installed, supervisor: 'native' }],
    ['a Backup Job', backupJob],
  ])('of %s parses without the fields this Collector does not know', (_, record) => {
    expect(parsedRecord({ ...record, restartPolicy: 'always' })).toEqual(record);
  });

  test('parses a Backup Job without scheduled time fields this Collector does not know', () => {
    const schedule = [{ hour: 3, minute: 15, second: 0 }];

    expect(parsedRecord({ ...backupJob, schedule })).toEqual({
      ...backupJob,
      schedule: [{ hour: 3, minute: 15 }],
    });
  });

  test('of an unknown schema version is refused as unknown', () => {
    expect(parseInstallRecord({ ...serviceInstall(), schemaVersion: 2 })).toEqual({
      kind: 'unknown-version',
      schemaVersion: 2,
    });
  });
});

describe('an install record may', () => {
  test('come from a commit Fleet ran with a dirty tree', () => {
    const dirty = { ...applicationInstall(), commit: `${applicationInstall().commit}-dirty` };

    expect(parsedRecord(dirty)).toEqual(dirty);
  });

  test('name no release when Fleet did not resolve one', () => {
    const unresolved = { ...applicationInstall(), release: null };

    expect(parsedRecord(unresolved)).toEqual(unresolved);
  });
});

describe('an install record is invalid', () => {
  const service = serviceInstall();
  const backupJob = backupJobInstall();

  test.each([
    ['of a kind Fleet does not install', { ...applicationInstall(), kind: 'harness' }],
    ['with an abbreviated commit', { ...applicationInstall(), commit: '3f1c2a9' }],
    [
      'with an install time finer than a second',
      { ...service, installedAt: '2026-10-08T03:22:21.5Z' },
    ],
    ['with an install time not in UTC', { ...service, installedAt: '2026-10-07T23:22:21-04:00' }],
    ['naming outside Fleet names', { ...service, name: 'Notes' }],
    ['without a schema version', { ...service, schemaVersion: undefined }],
    // The Collector requests health URLs, so a record must not aim it off the System.
    ['with a health URL off loopback', { ...service, healthUrl: 'http://192.0.2.7:8080/health' }],
    ['with a health URL on a loopback name', { ...service, healthUrl: 'http://localhost:8080/' }],
    ['with a health URL outside ASCII', { ...service, healthUrl: 'http://127.0.0.1:8080/é' }],
    ['with an HTTPS health URL', { ...service, healthUrl: 'https://127.0.0.1:8080/' }],
    [
      'with a health URL that hides another host',
      { ...service, healthUrl: 'http://127.0.0.1:8080@192.0.2.7/' },
    ],
    ['with a health URL port out of range', { ...service, healthUrl: 'http://127.0.0.1:70000/' }],
    ['with a health URL that is not a URL', { ...service, healthUrl: 'health' }],
    ['with a port out of range', { ...service, port: 70_000 }],
    ['of a systemd Service without its unit', { ...service, unit: undefined }],
    ['of a systemd Service with a unit that is not a service', { ...service, unit: 'notes.timer' }],
    ['of a docker Service without its container', { ...service, supervisor: 'docker' }],
    ['of a Backup Job without its label', { ...backupJob, label: undefined }],
    ['of a Backup Job that never runs', { ...backupJob, schedule: [] }],
    ['of a Backup Job that keeps nothing', { ...backupJob, retentionDays: 0 }],
    ['of a Backup Job with a relative destination', { ...backupJob, destination: 'notes' }],
    ['of a Backup Job under a supervisor Fleet does not use', { ...backupJob, supervisor: 'cron' }],
  ])('%s', (_, input) => {
    expect(parseInstallRecord(input).kind).toBe('invalid');
  });
});
