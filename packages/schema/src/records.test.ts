import { describe, expect, test } from 'bun:test';

import {
  ApplicationRecordSchema,
  FilesRecordSchema,
  JobRecordSchema,
  RunRecordSchema,
  ServiceRecordSchema,
} from './records.ts';

const SHA = 'a'.repeat(64);

const service = (health: string) => ({ health, name: 'api', supervisor: 'none' });
const serviceNamed = (record: object) => ServiceRecordSchema.safeParse({ name: 'api', ...record });
const job = (schedule: object[]) => ({
  name: 'backup',
  schedule,
  scheduler: 'systemd-timer',
  unit: 'backup.timer',
});
const files = (paths: string[]) => ({
  files: paths.map((path) => ({ path, sha256: SHA })),
  name: 'config',
});
const run = { exitStatus: 0, finished: '2026-10-01T03:00:05Z', started: '2026-10-01T03:00:00Z' };
const withOutput = (file: string) => ({ ...run, output: { file, sizeBytes: 10 } });

describe('a Service record', () => {
  test.each([
    'http://127.0.0.1:8080',
    'http://127.0.0.1:8080/healthz?full=1',
    'http://[::1]:65535/health',
  ])('accepts the loopback health URL %s', (health) => {
    expect(ServiceRecordSchema.safeParse(service(health)).success).toBe(true);
  });

  test.each([
    'http://localhost:8080/health',
    'http://127.0.0.1/health',
    'http://127.0.0.1:65536/health',
    'http://127.0.0.1:0/health',
    'https://127.0.0.1:8080/health',
    'http://127.0.0.1:8080@example.com/',
    'http://10.0.0.5:8080/health',
    'http://127.0.0.1:8080/a b',
  ])('refuses the health URL %s', (health) => {
    expect(ServiceRecordSchema.safeParse(service(health)).success).toBe(false);
  });

  test('requires the target its supervisor names, and none for none', () => {
    expect(serviceNamed({ supervisor: 'systemd', unit: 'api.service' }).success).toBe(true);
    expect(serviceNamed({ supervisor: 'systemd-user', unit: 'api.service' }).success).toBe(true);
    expect(serviceNamed({ label: 'com.example.api', supervisor: 'launchd' }).success).toBe(true);
    expect(serviceNamed({ container: 'api', supervisor: 'docker' }).success).toBe(true);
    expect(serviceNamed({ supervisor: 'systemd' }).success).toBe(false);
    expect(serviceNamed({ supervisor: 'launchd', unit: 'api.service' }).success).toBe(false);
    expect(serviceNamed({ supervisor: 'none', unit: 'api.service' }).success).toBe(false);
    expect(serviceNamed({ supervisor: 'pm2' }).success).toBe(false);
  });
});

describe('a job record', () => {
  test('refuses entries that match the same times, with Sunday as 0 or 7', () => {
    const result = JobRecordSchema.safeParse(job([{ weekday: 0 }, { weekday: 7 }]));

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'duplicate schedule entry',
    ]);
  });

  test('accepts different entries, and refuses an empty entry or an empty schedule', () => {
    expect(JobRecordSchema.safeParse(job([{ hour: 3 }, { hour: 3, minute: 30 }])).success).toBe(
      true,
    );
    expect(JobRecordSchema.safeParse(job([{}])).success).toBe(false);
    expect(JobRecordSchema.safeParse(job([])).success).toBe(false);
  });
});

describe('a files record', () => {
  test('refuses a relative path, a control character, and a repeated path', () => {
    expect(FilesRecordSchema.safeParse(files(['/etc/app.conf'])).success).toBe(true);
    expect(FilesRecordSchema.safeParse(files(['etc/app.conf'])).success).toBe(false);
    expect(FilesRecordSchema.safeParse(files(['/etc/app\n.conf'])).success).toBe(false);
    expect(FilesRecordSchema.safeParse(files(['/etc/a', '/etc/a'])).success).toBe(false);
  });
});

describe('a run record', () => {
  test('accepts a finish at or after the start and refuses one before it', () => {
    expect(RunRecordSchema.safeParse(run).success).toBe(true);
    expect(RunRecordSchema.safeParse({ ...run, finished: run.started }).success).toBe(true);
    expect(RunRecordSchema.safeParse({ ...run, finished: '2026-10-01T02:59:59Z' }).success).toBe(
      false,
    );
  });

  test('refuses sub-second times, offsets, and an exit status above 255', () => {
    expect(RunRecordSchema.safeParse({ ...run, started: '2026-10-01T03:00:00.5Z' }).success).toBe(
      false,
    );
    expect(
      RunRecordSchema.safeParse({ ...run, started: '2026-10-01T03:00:00+02:00' }).success,
    ).toBe(false);
    expect(RunRecordSchema.safeParse({ ...run, exitStatus: 256 }).success).toBe(false);
  });

  test('refuses an output file that names a path', () => {
    expect(RunRecordSchema.safeParse(withOutput('backup-2026-10-01.tar.gz')).success).toBe(true);
    expect(RunRecordSchema.safeParse(withOutput('../backup.tar.gz')).success).toBe(false);
    expect(RunRecordSchema.safeParse(withOutput('..')).success).toBe(false);
  });
});

test('every record refuses a field it does not name', () => {
  expect(
    ApplicationRecordSchema.safeParse({ extra: 1, name: 'app', version: '1.0.0' }).success,
  ).toBe(false);
  expect(
    ApplicationRecordSchema.safeParse({
      name: 'app',
      provenance: { by: 'fleet', extra: 1 },
      version: '1.0.0',
    }).success,
  ).toBe(false);
});
