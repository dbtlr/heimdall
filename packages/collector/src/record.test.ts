import { describe, expect, test } from 'bun:test';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openRecords } from './records.ts';
import { invoke } from './testing/cli.ts';
import { tempStateDir } from './testing/fixtures.ts';

const DAY_MS = 86_400_000;
const SHA = 'ab'.repeat(32);

// Valid records of each kind, as a provisioner would pipe them.
const application = { name: 'webapp', source: 'https://example.com/webapp.tgz', version: '1.4.2' };
const service = {
  health: 'http://127.0.0.1:8080/healthz',
  name: 'webapp',
  port: 8080,
  provenance: { by: 'my-tool', revision: 'abc123' },
  supervisor: 'systemd',
  unit: 'webapp.service',
};
const job = {
  label: 'com.example.backup',
  name: 'backup',
  schedule: [{ hour: 3, minute: 30 }, { weekday: 0 }],
  scheduler: 'launchd',
};
const files = { files: [{ path: '/etc/webapp.conf', sha256: SHA }], name: 'webapp-config' };
const kinds = { application, files, job, service };

const at = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, 'Z');
// A run that started `daysAgo` days before now and took five seconds.
const run = (daysAgo: number, exitStatus = 0) => {
  const started = Math.floor((Date.now() - daysAgo * DAY_MS) / 1000) * 1000;
  return { exitStatus, finished: at(started + 5000), started: at(started) };
};

// Runs `heimdall-collector` with `argv`, `value` piped to it as JSON, and `dir` as its state directory.
const pipe = (argv: string[], value: unknown, dir: string) =>
  invoke([...argv, '--state-dir', dir], {
    stdin: typeof value === 'string' ? value : JSON.stringify(value),
  });

const stored = async (dir: string) => {
  const store = await openRecords({ stateDir: dir });
  try {
    return store.read();
  } finally {
    store.close();
  }
};

// The record is refused: nothing is stored and stderr names `message`.
const refuses = async (kind: string, body: unknown, message: string) => {
  await using dir = await tempStateDir();

  const result = await pipe(['record', kind], body, dir.path);

  expect(result.stderr).toContain(message);
  expect(result.stdout).toBe('');
  expect(result.code).toBe(1);
  expect(await stored(dir.path)).toEqual({ records: [], runs: [] });
};

describe('record', () => {
  test.each(Object.entries(kinds))(
    '%s is validated, stored, and acknowledged',
    async (kind, body) => {
      await using dir = await tempStateDir();

      const result = await pipe(['record', kind], body, dir.path);

      expect(result.stdout).toBe(`Recorded ${kind} ${body.name}.\n`);
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      const expected: unknown[] = [{ kind, name: body.name, record: body }];
      const actual: unknown[] = (await stored(dir.path)).records;
      expect(actual).toEqual(expected);
    },
  );

  test('every kind of Service takes the target its supervisor names', async () => {
    await using dir = await tempStateDir();
    const services = [
      { name: 'a', supervisor: 'systemd-user', unit: 'a.service' },
      { label: 'com.example.b', name: 'b', supervisor: 'launchd' },
      { container: 'c', name: 'c', supervisor: 'docker' },
      { health: 'http://[::1]:9000', name: 'd', supervisor: 'none' },
    ];

    for (const body of services) {
      // oxlint-disable-next-line no-await-in-loop -- records go in one at a time.
      expect((await pipe(['record', 'service'], body, dir.path)).code).toBe(0);
    }

    expect((await stored(dir.path)).records.map((entry) => entry.name)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  test('creates a state directory private to its owner and needs no pairing', async () => {
    await using dir = await tempStateDir();
    const stateDir = join(dir.path, 'not', 'yet');

    const result = await pipe(['record', 'application'], application, stateDir);

    expect(result.code).toBe(0);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
  });

  test('keeps its records in the state directory the environment names', async () => {
    await using dir = await tempStateDir();

    const result = await invoke(['record', 'application'], {
      env: { HEIMDALL_STATE_DIR: dir.path },
      stdin: JSON.stringify(application),
    });

    expect(result.code).toBe(0);
    expect((await stored(dir.path)).records).toHaveLength(1);
  });

  test('recording a kind and name again replaces the record', async () => {
    await using dir = await tempStateDir();
    await pipe(['record', 'application'], application, dir.path);
    await pipe(['record', 'application'], { ...application, version: '1.5.0' }, dir.path);
    await pipe(['record', 'service'], service, dir.path);

    const { records } = await stored(dir.path);

    // The Application and the Service share a name but not a kind.
    expect(records.map(({ kind, name }) => `${kind}:${name}`)).toEqual([
      'application:webapp',
      'service:webapp',
    ]);
    expect(records[0]?.record).toMatchObject({ version: '1.5.0' });
  });

  test('--help describes each kind', async () => {
    const { stdout } = await invoke(['record', '--help']);

    for (const kind of ['application', 'service', 'job', 'files', 'run']) {
      expect(stdout).toContain(kind);
    }
  });
});

describe('record refuses', () => {
  test.each([
    ['at the top level', 'application', { ...application, extra: 1 }, 'extra'],
    [
      'in provenance',
      'application',
      { ...application, provenance: { by: 'my-tool', extra: 1 } },
      'provenance',
    ],
    ['in a schedule entry', 'job', { ...job, schedule: [{ hour: 3, year: 2026 }] }, 'schedule[0]'],
    ['in a file', 'files', { ...files, files: [{ ...files.files[0], mode: '0644' }] }, 'files[0]'],
  ])('a field it does not know, %s', (_, kind, body, path) => refuses(kind, body, path));

  test.each([
    [
      'a health URL on localhost',
      'service',
      { ...service, health: 'http://localhost:8080/' },
      'health',
    ],
    [
      'a health URL off the loopback address',
      'service',
      { ...service, health: 'http://10.0.0.5:80/' },
      'health',
    ],
    [
      'a supervisor without its target',
      'service',
      { name: 'webapp', supervisor: 'launchd' },
      'label',
    ],
    ['a port above 65535', 'service', { ...service, port: 65_536 }, 'port'],
    [
      'a duplicate schedule entry',
      'job',
      { ...job, schedule: [{ hour: 3 }, { hour: 3 }] },
      'duplicate schedule entry',
    ],
    ['an empty schedule', 'job', { ...job, schedule: [] }, 'schedule'],
    [
      'a relative file path',
      'files',
      { ...files, files: [{ path: 'etc/a.conf', sha256: SHA }] },
      'files[0].path',
    ],
    [
      'a bad hash',
      'files',
      { ...files, files: [{ path: '/etc/a.conf', sha256: SHA.toUpperCase() }] },
      'files[0].sha256',
    ],
    ['a name that starts with a dot', 'application', { ...application, name: '.hidden' }, 'name'],
    ['a name with a slash', 'application', { ...application, name: 'a/b' }, 'name'],
    [
      'a version with a control character',
      'application',
      { ...application, version: '1\n2' },
      'version',
    ],
    ['no version', 'application', { name: 'webapp' }, 'version'],
    ['something other than an object', 'application', '[1]', 'expected object'],
  ])('%s', (_, kind, body, message) => refuses(kind, body, message));

  test('input that is not JSON, without echoing it', async () => {
    await using dir = await tempStateDir();

    const result = await pipe(['record', 'application'], '{"name": "SECRET-VALUE"', dir.path);

    expect(result.stderr).toContain('not valid JSON');
    expect(result.stderr).not.toContain('SECRET-VALUE');
    expect(result.code).toBe(1);
  });

  test('a bad value without echoing it', async () => {
    await using dir = await tempStateDir();

    const result = await pipe(
      ['record', 'application'],
      { ...application, version: 'SECRET-VALUE\u0007' },
      dir.path,
    );

    expect(result.stderr).toContain('version');
    expect(result.stderr).not.toContain('SECRET-VALUE');
    expect(result.code).toBe(1);
  });

  test('empty input', async () => {
    await using dir = await tempStateDir();

    const result = await invoke(['record', 'application', '--state-dir', dir.path], {
      stdin: ' \n',
    });

    expect(result.stderr).toContain('empty');
    expect(result.code).toBe(1);
  });

  test('a terminal, telling the user to pipe a JSON record', async () => {
    await using dir = await tempStateDir();

    const result = await invoke(['record', 'application', '--state-dir', dir.path], {
      stdinIsTerminal: true,
    });

    expect(result.stderr).toContain('Pipe a JSON record');
    expect(result.code).toBe(1);
  });

  test('input over 1 MiB', async () => {
    await using dir = await tempStateDir();
    const body = JSON.stringify(application) + ' '.repeat(1024 * 1024);

    const result = await pipe(['record', 'application'], body, dir.path);

    expect(result.stderr).toContain('1 MiB');
    expect(result.code).toBe(1);
    expect(await stored(dir.path)).toEqual({ records: [], runs: [] });
  });

  test('a state directory that cannot be created', async () => {
    await using dir = await tempStateDir();
    await writeFile(join(dir.path, 'a-file'), '');

    const result = await pipe(
      ['record', 'application'],
      application,
      join(dir.path, 'a-file', 'x'),
    );

    expect(result.stderr).toContain('state directory');
    expect(result.code).toBe(1);
  });
});

const recordJob = (dir: string) => pipe(['record', 'job'], job, dir);
const recordRun = (dir: string, value: unknown) => pipe(['record', 'run', 'backup'], value, dir);

describe('record run', () => {
  test('stores a run of a recorded job, keyed by job and start', async () => {
    await using dir = await tempStateDir();
    await recordJob(dir.path);
    const first = { ...run(1), output: { file: 'backup-1.tar.gz', sizeBytes: 2048 } };

    const result = await recordRun(dir.path, first);
    await recordRun(dir.path, { ...first, exitStatus: 1 });

    expect(result.stdout).toBe(`Recorded run of backup started ${first.started}.\n`);
    expect(result.code).toBe(0);
    // The second run has the same start, so it replaced the first.
    expect((await stored(dir.path)).runs).toEqual([
      { job: 'backup', run: { ...first, exitStatus: 1 } },
    ]);
  });

  test('is refused for a job that has no job record', async () => {
    await using dir = await tempStateDir();

    const result = await recordRun(dir.path, run(1));

    expect(result.stderr).toContain('No job backup is recorded');
    expect(result.code).toBe(1);
    expect((await stored(dir.path)).runs).toEqual([]);
  });

  test.each([
    [
      'a run that finished before it started',
      { ...run(1), finished: at(Date.now() - 3 * DAY_MS) },
      'finished',
    ],
    [
      'a time with fractions of a second',
      { ...run(1), started: '2026-10-01T03:00:00.5Z' },
      'started',
    ],
    ['an exit status above 255', { ...run(1), exitStatus: 256 }, 'exitStatus'],
    [
      'an output file that names a path',
      { ...run(1), output: { file: '../x', sizeBytes: 1 } },
      'output.file',
    ],
    ['a field it does not know', { ...run(1), signal: 'KILL' }, 'signal'],
  ])('refuses %s', async (_, body, message) => {
    await using dir = await tempStateDir();
    await recordJob(dir.path);

    const result = await recordRun(dir.path, body);

    expect(result.stderr).toContain(message);
    expect(result.code).toBe(1);
    expect((await stored(dir.path)).runs).toEqual([]);
  });

  test('refuses a job name that is not one', async () => {
    await using dir = await tempStateDir();

    const result = await pipe(['record', 'run', '../x'], run(1), dir.path);

    expect(result.stderr).toContain('name');
    expect(result.code).toBe(1);
  });

  test('prunes runs more than 90 days old but keeps the latest success', async () => {
    await using dir = await tempStateDir();
    await recordJob(dir.path);
    const oldSuccess = run(120);
    const oldFailure = run(100, 1);
    const recentFailure = run(1, 2);
    for (const body of [oldSuccess, oldFailure, recentFailure]) {
      // oxlint-disable-next-line no-await-in-loop -- runs go in one at a time.
      await recordRun(dir.path, body);
    }

    expect((await stored(dir.path)).runs.map(({ run: { started } }) => started)).toEqual([
      oldSuccess.started,
      recentFailure.started,
    ]);

    // A newer success ends the old one's protection.
    const recentSuccess = run(2);
    await recordRun(dir.path, recentSuccess);

    expect((await stored(dir.path)).runs.map(({ run: { started } }) => started)).toEqual([
      recentSuccess.started,
      recentFailure.started,
    ]);
  });
});

describe('forget', () => {
  test.each(Object.entries(kinds))('removes a recorded %s', async (kind, body) => {
    await using dir = await tempStateDir();
    await pipe(['record', kind], body, dir.path);
    await pipe(['record', kind], { ...body, name: 'other' }, dir.path);

    const result = await invoke(['forget', kind, body.name, '--state-dir', dir.path]);

    expect(result.stdout).toBe(`Forgot ${kind} ${body.name}.\n`);
    expect(result.code).toBe(0);
    expect((await stored(dir.path)).records.map((entry) => entry.name)).toEqual(['other']);
  });

  test.each(['application', 'service', 'job', 'files'])(
    'of a %s that is not recorded succeeds, so an uninstall can run it safely',
    async (kind) => {
      await using dir = await tempStateDir();

      const result = await invoke(['forget', kind, 'ghost', '--state-dir', dir.path]);

      expect(result.stdout).toBe(`No ${kind} ghost is recorded.\n`);
      expect(result.code).toBe(0);
    },
  );

  test('a job removes its runs and leaves other jobs alone', async () => {
    await using dir = await tempStateDir();
    await pipe(['record', 'job'], job, dir.path);
    await pipe(['record', 'job'], { ...job, name: 'sync' }, dir.path);
    await pipe(['record', 'run', 'backup'], run(1), dir.path);
    await pipe(['record', 'run', 'sync'], run(1), dir.path);

    await invoke(['forget', 'job', 'backup', '--state-dir', dir.path]);

    expect((await stored(dir.path)).runs.map(({ job: name }) => name)).toEqual(['sync']);
  });

  test('refuses a name that is not one', async () => {
    await using dir = await tempStateDir();

    const result = await invoke(['forget', 'application', 'a/b', '--state-dir', dir.path]);

    expect(result.stderr).toContain('name');
    expect(result.code).toBe(1);
  });

  test('without a name is a usage error', async () => {
    await using dir = await tempStateDir();

    const result = await invoke(['forget', 'application', '--state-dir', dir.path]);

    expect(result.code).toBe(2);
  });
});
