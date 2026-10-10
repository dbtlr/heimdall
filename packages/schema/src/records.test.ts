import { describe, expect, test } from 'bun:test';

import {
  ApplicationRecordSchema,
  FilesRecordSchema,
  JobRecordSchema,
  RunRecordSchema,
  ServiceRecordSchema,
} from './records.ts';

const SHA = 'a'.repeat(64);
const JOB = { label: 'l', name: 'j', schedule: [{ hour: 1 }], scheduler: 'launchd' };

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

const entryOf = (field: string, value: number) => ({
  ...JOB,
  schedule: [{ [field]: value }],
});

const scheduleOf = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    hour: Math.floor(index / 60),
    minute: index % 60,
  }));
const withHealth = (url: string) => ({ health: url, name: 's', supervisor: 'none' });
const filesOf = (count: number) => ({
  files: Array.from({ length: count }, (_, index) => ({
    path: `/f${String(index)}`,
    sha256: SHA,
  })),
  name: 'c',
});
const one = (path: string, sha256 = SHA) => ({ files: [{ path, sha256 }], name: 'c' });

// Whether a schema accepts `value`.
const accepts = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe('a calendar entry', () => {
  test.each([
    ['minute', 0, true],
    ['minute', 59, true],
    ['minute', 60, false],
    ['minute', -1, false],
    ['minute', 1.5, false],
    ['hour', 0, true],
    ['hour', 23, true],
    ['hour', 24, false],
    ['hour', -1, false],
    ['day', 0, false],
    ['day', 1, true],
    ['day', 31, true],
    ['day', 32, false],
    ['weekday', 0, true],
    ['weekday', 7, true],
    ['weekday', 8, false],
    ['weekday', -1, false],
    ['month', 0, false],
    ['month', 1, true],
    ['month', 12, true],
    ['month', 13, false],
  ])('takes %s of %d: %s', (field, value, accepted) => {
    expect(accepts(JobRecordSchema, entryOf(field, value))).toBe(accepted);
  });

  test('the schedule holds 1 to 100 entries', () => {
    expect(accepts(JobRecordSchema, { ...JOB, schedule: scheduleOf(1) })).toBe(true);
    expect(accepts(JobRecordSchema, { ...JOB, schedule: scheduleOf(100) })).toBe(true);
    expect(accepts(JobRecordSchema, { ...JOB, schedule: scheduleOf(101) })).toBe(false);
    expect(accepts(JobRecordSchema, { ...JOB, schedule: [] })).toBe(false);
  });
});

describe('a job record', () => {
  test('needs the target its scheduler names, and no field it does not name', () => {
    expect(
      accepts(JobRecordSchema, { name: 'j', schedule: [{ hour: 1 }], scheduler: 'launchd' }),
    ).toBe(false);
    expect(
      accepts(JobRecordSchema, { name: 'j', schedule: [{ hour: 1 }], scheduler: 'systemd-timer' }),
    ).toBe(false);
    expect(accepts(JobRecordSchema, { ...JOB, cron: '0 3 * * *' })).toBe(false);
    expect(accepts(JobRecordSchema, { ...JOB, unit: 'j.timer' })).toBe(false);
  });

  test.each([
    { label: 'l', scheduler: 'launchd' },
    { scheduler: 'systemd-timer', unit: 'j.timer' },
  ])('refuses an unknown field beside %j', (target) => {
    const valid = { name: 'j', schedule: [{ hour: 1 }], ...target };
    expect(accepts(JobRecordSchema, valid)).toBe(true);
    expect(accepts(JobRecordSchema, { ...valid, cron: '0 3 * * *' })).toBe(false);
  });

  test('takes a grace period of 1 minute to a week, in whole minutes', () => {
    expect(accepts(JobRecordSchema, { ...JOB, graceMinutes: 1 })).toBe(true);
    expect(accepts(JobRecordSchema, { ...JOB, graceMinutes: 10_080 })).toBe(true);
    expect(accepts(JobRecordSchema, { ...JOB, graceMinutes: 0 })).toBe(false);
    expect(accepts(JobRecordSchema, { ...JOB, graceMinutes: 10_081 })).toBe(false);
    expect(accepts(JobRecordSchema, { ...JOB, graceMinutes: 90.5 })).toBe(false);
  });
});

describe('a Service record', () => {
  test('needs the target its supervisor names, and no field it does not name', () => {
    expect(accepts(ServiceRecordSchema, { name: 's', supervisor: 'systemd-user' })).toBe(false);
    expect(accepts(ServiceRecordSchema, { name: 's', supervisor: 'docker' })).toBe(false);
    expect(accepts(ServiceRecordSchema, { name: 's', restart: true, supervisor: 'none' })).toBe(
      false,
    );
  });

  test.each([
    { supervisor: 'systemd', unit: 'api.service' },
    { supervisor: 'systemd-user', unit: 'api.service' },
    { label: 'com.example.api', supervisor: 'launchd' },
    { container: 'api', supervisor: 'docker' },
    { supervisor: 'none' },
  ])('refuses an unknown field beside %j', (target) => {
    const valid = { name: 's', ...target };
    expect(accepts(ServiceRecordSchema, valid)).toBe(true);
    expect(accepts(ServiceRecordSchema, { ...valid, restart: true })).toBe(false);
  });

  test.each([
    [0, false],
    [1, true],
    [65_535, true],
    [65_536, false],
    [8080.5, false],
  ])('takes port %d: %s', (port, accepted) => {
    expect(accepts(ServiceRecordSchema, { name: 's', port, supervisor: 'none' })).toBe(accepted);
  });

  test('takes a health URL only over plain http', () => {
    expect(accepts(ServiceRecordSchema, withHealth('http://127.0.0.1:80'))).toBe(true);
    expect(accepts(ServiceRecordSchema, withHealth('https://127.0.0.1:80'))).toBe(false);
    expect(accepts(ServiceRecordSchema, withHealth('http://127.0.0.1:80/a b'))).toBe(false);
  });
});

describe('a name', () => {
  test.each([
    ['a', true],
    ['a'.repeat(128), true],
    ['a'.repeat(129), false],
    ['', false],
    ['-a', false],
    ['a.b_c-d', true],
    ['a b', false],
    ['é', false],
  ])('%j is accepted: %s', (name, accepted) => {
    expect(accepts(ApplicationRecordSchema, { name, version: '1' })).toBe(accepted);
  });
});

describe('a text field', () => {
  const limits = [
    ['version', 128, (value: string) => ({ name: 'a', version: value })],
    ['source', 256, (value: string) => ({ name: 'a', source: value, version: '1' })],
    [
      'provenance.by',
      64,
      (value: string) => ({ name: 'a', provenance: { by: value }, version: '1' }),
    ],
    [
      'provenance.revision',
      128,
      (value: string) => ({ name: 'a', provenance: { by: 'p', revision: value }, version: '1' }),
    ],
  ] as const;

  test.each(limits)('%s takes 1 to %d characters', (_, max, record) => {
    expect(accepts(ApplicationRecordSchema, record('x'.repeat(max)))).toBe(true);
    expect(accepts(ApplicationRecordSchema, record('x'.repeat(max + 1)))).toBe(false);
    expect(accepts(ApplicationRecordSchema, record(''))).toBe(false);
  });

  test.each(limits)('%s refuses a control character and a lone surrogate', (_, __, record) => {
    expect(accepts(ApplicationRecordSchema, record('a\u0007b'))).toBe(false);
    expect(accepts(ApplicationRecordSchema, record('a\u007fb'))).toBe(false);
    expect(accepts(ApplicationRecordSchema, record('a\ud800b'))).toBe(false);
    expect(accepts(ApplicationRecordSchema, record('a\u{1f600}b'))).toBe(true);
  });

  test.each(['web*', 'web?.service', 'web[12].service', '*', '12345', '0'])(
    'a systemd unit of %s is refused, since systemctl reads it as a pattern or a job id',
    (unit) => {
      expect(accepts(ServiceRecordSchema, { name: 's', supervisor: 'systemd', unit })).toBe(false);
      expect(accepts(ServiceRecordSchema, { name: 's', supervisor: 'systemd-user', unit })).toBe(
        false,
      );
    },
  );

  test('says why a systemd unit is refused', () => {
    const refused = ServiceRecordSchema.safeParse({
      name: 's',
      supervisor: 'systemd',
      unit: 'web*',
    });

    expect(JSON.stringify(refused.error?.issues)).toContain(
      'must name one unit: no *, ? or [ and not only digits',
    );
  });

  test.each(['web.service', 'web@1.service', 'web-2.service', 'app.slice', 'v2'])(
    'a systemd unit of %s is accepted',
    (unit) => {
      expect(accepts(ServiceRecordSchema, { name: 's', supervisor: 'systemd', unit })).toBe(true);
    },
  );

  test.each(['com.example/web', '/com.example.web', 'gui/501/com.example.web'])(
    'a launchd label of %s is refused, since launchctl reads a / as part of the service target',
    (label) => {
      expect(accepts(ServiceRecordSchema, { label, name: 's', supervisor: 'launchd' })).toBe(false);
    },
  );

  test('a launchd label is not read as a pattern', () => {
    expect(
      accepts(ServiceRecordSchema, { label: 'com.example.*', name: 's', supervisor: 'launchd' }),
    ).toBe(true);
  });

  test.each(['web', 'web_1', 'my-app.v2', '123', 'abc123def456', 'A', 'a'.repeat(256)])(
    'a docker container of %s is accepted',
    (container) => {
      expect(accepts(ServiceRecordSchema, { container, name: 's', supervisor: 'docker' })).toBe(
        true,
      );
    },
  );

  // Docker names a container with [a-zA-Z0-9][a-zA-Z0-9_.-]*, and an ID is hex.
  // Anything else, including `:`, which Docker refuses in a name, could change
  // the Engine API path the Collector asks.
  test.each([
    '',
    '.',
    '..',
    '-web',
    '_web',
    'a/b',
    'a:b',
    'a?b',
    'a#b',
    'a%2Fb',
    'a b',
    'web\n',
    'wéb',
    '/web',
    'a'.repeat(257),
  ])('a docker container of %j is refused', (container) => {
    expect(accepts(ServiceRecordSchema, { container, name: 's', supervisor: 'docker' })).toBe(
      false,
    );
  });

  test('a Service unit, a launchd label, and a container are text too', () => {
    expect(
      accepts(ServiceRecordSchema, { name: 's', supervisor: 'systemd', unit: 'a\ud800' }),
    ).toBe(false);
    expect(
      accepts(ServiceRecordSchema, { name: 's', supervisor: 'systemd', unit: 'x'.repeat(257) }),
    ).toBe(false);
  });
});

describe('a file', () => {
  test('a record holds 1 to 10,000 files', () => {
    expect(accepts(FilesRecordSchema, filesOf(1))).toBe(true);
    expect(accepts(FilesRecordSchema, filesOf(10_000))).toBe(true);
    expect(accepts(FilesRecordSchema, filesOf(10_001))).toBe(false);
    expect(accepts(FilesRecordSchema, filesOf(0))).toBe(false);
  });

  test.each([
    ['a'.repeat(64), true],
    ['a'.repeat(63), false],
    ['a'.repeat(65), false],
    ['A'.repeat(64), false],
    [`${'a'.repeat(63)}g`, false],
  ])('hash %j is accepted: %s', (sha256, accepted) => {
    expect(accepts(FilesRecordSchema, one('/a', sha256))).toBe(accepted);
  });

  test('a path is at most 4096 bytes, not characters', () => {
    expect(accepts(FilesRecordSchema, one(`/${'a'.repeat(4095)}`))).toBe(true);
    expect(accepts(FilesRecordSchema, one(`/${'a'.repeat(4096)}`))).toBe(false);
    // 2047 two-byte characters and one more byte fill 4096 bytes; one more character is 4098.
    expect(accepts(FilesRecordSchema, one(`/${'é'.repeat(2047)}a`))).toBe(true);
    expect(accepts(FilesRecordSchema, one(`/${'é'.repeat(2048)}`))).toBe(false);
  });

  test.each(['/a\u0007b', '/a\nb', '/a\u0000b', '/a\u007fb', '/a\ud800b'])(
    'refuses the path %j',
    (path) => {
      expect(accepts(FilesRecordSchema, one(path))).toBe(false);
    },
  );

  test.each([
    ['/a', true],
    ['/a/b.c', true],
    ['/a/.hidden', true],
    ['/a/..b', true],
    ['/', false],
    ['//a', false],
    ['/a//b', false],
    ['/a/', false],
    ['/a/./b', false],
    ['/a/../b', false],
    ['/..', false],
    ['a/b', false],
    ['', false],
  ])('the path %j is accepted: %s', (path, accepted) => {
    expect(accepts(FilesRecordSchema, one(path))).toBe(accepted);
  });

  test('refuses an unknown field in a file and a repeated path', () => {
    expect(
      accepts(FilesRecordSchema, { files: [{ mode: 1, path: '/a', sha256: SHA }], name: 'c' }),
    ).toBe(false);
    expect(accepts(FilesRecordSchema, { ...one('/a'), extra: 1 })).toBe(false);
  });
});

describe('a run', () => {
  test.each([
    [-1, false],
    [0, true],
    [255, true],
    [256, false],
    [1.5, false],
  ])('takes exit status %d: %s', (exitStatus, accepted) => {
    expect(accepts(RunRecordSchema, { ...run, exitStatus })).toBe(accepted);
  });

  test.each([
    ['a.tar.gz', 1, true],
    ['x'.repeat(255), 1, true],
    ['x'.repeat(256), 1, false],
    ['.', 1, false],
    ['..', 1, false],
    ['', 1, false],
    ['...', 1, true],
    ['a/b', 1, false],
    ['a\u0007', 1, false],
    ['é', 1, false],
    ['a b', 1, true],
    ['a.gz', 0, true],
    ['a.gz', -1, false],
    ['a.gz', 1.5, false],
  ])('takes the output file %j of %d bytes: %s', (file, sizeBytes, accepted) => {
    expect(accepts(RunRecordSchema, { ...run, output: { file, sizeBytes } })).toBe(accepted);
  });

  test('refuses an unknown field inside output and at the top level', () => {
    expect(accepts(RunRecordSchema, { ...run, output: { file: 'a', mode: 1, sizeBytes: 1 } })).toBe(
      false,
    );
    expect(accepts(RunRecordSchema, { ...run, host: 'x' })).toBe(false);
  });
});
