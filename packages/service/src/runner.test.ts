import { expect, test } from 'bun:test';

import { createSpawnRunner } from './runner.ts';

// Only harmless commands run here: sleep and printenv.
const PATH = process.env.PATH ?? '/usr/bin:/bin';

test('a command that outlives the timeout is stopped and reads as failed', async () => {
  const started = Date.now();

  const result = await createSpawnRunner({ env: { PATH }, timeoutMs: 50, uid: 1000 })([
    'sleep',
    '5',
  ]);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('timed out after 0.05 s');
  expect(Date.now() - started).toBeLessThan(2000);
});

test('a command that finishes in time reports its own result', async () => {
  const result = await createSpawnRunner({ env: { PATH }, uid: 1000 })(['printenv', 'PATH']);

  expect(result).toEqual({ code: 0, stderr: '', stdout: `${PATH}\n` });
});

test('commands find the user manager when XDG_RUNTIME_DIR is unset, as under sudo -u', async () => {
  const result = await createSpawnRunner({ env: { PATH }, uid: 4242 })([
    'printenv',
    'XDG_RUNTIME_DIR',
  ]);

  expect(result.stdout).toBe('/run/user/4242\n');
});

test('a set XDG_RUNTIME_DIR is passed on as it is', async () => {
  const result = await createSpawnRunner({
    env: { PATH, XDG_RUNTIME_DIR: '/run/user/1000' },
    uid: 4242,
  })(['printenv', 'XDG_RUNTIME_DIR']);

  expect(result.stdout).toBe('/run/user/1000\n');
});
