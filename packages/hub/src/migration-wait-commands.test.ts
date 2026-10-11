import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';

import { app } from './application.ts';
import { migrate } from './migrations.ts';
import { testDatabase } from './testing/postgres.ts';

const WAITING = 'Waiting for a database lock';
// A wait begins once the first migration attempt has timed out on the 5-second lock timeout.
const SLOW_TEST_MS = 30_000;

// Runs the Hub command line in-process and aborts the run as soon as `abortWhen`
// is seen in its output.
const runUntil = async (argv: string[], { abortWhen = WAITING } = {}) => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const controller = new AbortController();
  const safety = setTimeout(() => controller.abort(), 20_000);
  const home = await mkdtemp(join(tmpdir(), 'heimdall-hub-home-'));
  let output = '';
  const watch = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes(abortWhen)) {
      controller.abort();
    }
  };
  stdout.on('data', watch);
  stderr.on('data', watch);
  const errors = text(stderr);
  const logged = text(stdout);
  const runnerExitCode = process.exitCode;
  let code: number;
  try {
    code = await app.run({
      host: { argv, env: { HOME: home }, stderr, stdout },
      signal: controller.signal,
    });
  } finally {
    process.exitCode = runnerExitCode;
    clearTimeout(safety);
    await rm(home, { force: true, recursive: true });
  }
  stdout.end();
  stderr.end();
  return { code, stderr: await errors, stdout: await logged };
};

// A migrated database where another session holds the lock every migration needs
// to read what is applied, as a stalled backup would.
const lockedDatabase = async () => {
  const db = await testDatabase();
  await migrate(db.sql);
  const session = await db.sql.reserve();
  await session.unsafe("SET application_name = 'stalled-backup'");
  await session.unsafe('BEGIN');
  await session.unsafe('LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE');
  return {
    db,
    [Symbol.asyncDispose]: async () => {
      await session.unsafe('ROLLBACK');
      session.release();
      await db[Symbol.asyncDispose]();
    },
  };
};

test.concurrent(
  'pair waits on a held lock, names the holder, and ends quietly with the interrupt code when stopped',
  async () => {
    await using locked = await lockedDatabase();

    const { code, stderr } = await runUntil(['pair', 'laptop-1', '--database', locked.db.url.href]);

    expect(stderr).toContain('stalled-backup');
    expect(stderr).toContain('schema_migrations');
    expect(stderr).toContain('Interrupted while waiting for a database lock.');
    expect(stderr).not.toContain('Could not reach the database');
    expect(code).toBe(130);
  },
  SLOW_TEST_MS,
);

test.concurrent(
  'serve waits on a held lock without listening, and a stop ends it without a fatal line',
  async () => {
    await using locked = await lockedDatabase();

    const { code, stderr, stdout } = await runUntil([
      'serve',
      '--database',
      locked.db.url.href,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
    ]);

    expect(stdout).toContain('warning: Waiting for a database lock');
    expect(stdout).toContain('stalled-backup');
    expect(stdout).not.toContain('Listening on');
    expect(stderr).toBe('');
    expect(code).toBe(130);
  },
  SLOW_TEST_MS,
);

test('serve does not listen when it is stopped as the migrations finish', async () => {
  await using db = await testDatabase();

  const { stdout } = await runUntil(
    ['serve', '--database', db.url.href, '--host', '127.0.0.1', '--port', '0'],
    { abortWhen: 'Applied database migrations' },
  );

  expect(stdout).toContain('Applied database migrations');
  expect(stdout).not.toContain('Listening on');
});

test('pair issues no Pairing code when it is stopped as the migrations finish', async () => {
  await using db = await testDatabase();

  const { code, stdout } = await runUntil(['pair', 'laptop-1', '--database', db.url.href], {
    abortWhen: 'Applied database migrations',
  });

  expect(stdout).toContain('Applied database migrations');
  const [{ count }] = await db.sql`SELECT count(*)::int AS count FROM pairing_codes`;
  expect(count).toBe(0);
  expect(code).toBe(130);
});
