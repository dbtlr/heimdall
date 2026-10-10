import { expect, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { COMMAND_TIMEOUT_MS, readCommand, runCommand } from './subprocess.ts';
import { tempStateDir } from './testing/fixtures.ts';

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a command that exits answers its status and what it wrote', async () => {
  const result = await runCommand(['/bin/sh', '-c', 'echo out; echo err >&2; exit 3']);

  expect(result).toEqual({ exitCode: 3, kind: 'exited', stderr: 'err\n', stdout: 'out\n' });
});

test('a command that outlives the timeout is killed and reported as timed out', async () => {
  await using dir = await tempStateDir();
  const pidFile = join(dir.path, 'pid');

  const result = await runCommand(['/bin/sh', '-c', `echo $$ > ${pidFile}; exec sleep 30`], {
    timeoutMs: 200,
  });

  expect(result).toEqual({ kind: 'timed out' });
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  // The kill is a signal, so the process may take a moment to be reaped.
  const gone = await Bun.sleep(100).then(() => !isAlive(pid));
  expect(gone).toBe(true);
});

test('a command that ignores SIGTERM is still killed at the timeout', async () => {
  await using dir = await tempStateDir();
  const pidFile = join(dir.path, 'pid');

  const result = await runCommand(
    ['/bin/sh', '-c', `trap '' TERM; echo $$ > ${pidFile}; while :; do :; done`],
    { timeoutMs: 300 },
  );

  expect(result).toEqual({ kind: 'timed out' });
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  const gone = await Bun.sleep(100).then(() => !isAlive(pid));
  expect(gone).toBe(true);
});

test('the default timeout is 5 seconds', async () => {
  const set = spyOn(globalThis, 'setTimeout');
  try {
    await runCommand(['/bin/sh', '-c', 'exit 0']);

    expect(COMMAND_TIMEOUT_MS).toBe(5000);
    expect(set.mock.calls.map(([, delay]) => delay)).toContain(5000);
  } finally {
    set.mockRestore();
  }
});

test('a command that finishes leaves no timer pending, so it cannot kill anything later', async () => {
  const set = spyOn(globalThis, 'setTimeout');
  const clear = spyOn(globalThis, 'clearTimeout');
  try {
    await runCommand(['/bin/sh', '-c', 'exit 0'], { timeoutMs: 123_456 });

    const index = set.mock.calls.findIndex(([, delay]) => delay === 123_456);
    expect(index).toBeGreaterThanOrEqual(0);
    const handle: unknown = set.mock.results[index]?.value;
    expect(clear.mock.calls.map(([cleared]): unknown => cleared)).toContain(handle);
  } finally {
    set.mockRestore();
    clear.mockRestore();
  }
});

test('a command that finishes within the timeout is not cut short', async () => {
  const result = await runCommand(['/bin/sh', '-c', 'sleep 0.1; echo done'], { timeoutMs: 5000 });

  expect(result).toMatchObject({ exitCode: 0, kind: 'exited', stdout: 'done\n' });
});

test('a command that cannot be started rejects', async () => {
  const failure = await runCommand(['/nonexistent/tool']).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(Error);
});

test('reading a command answers its output, and throws when it exits non-zero', async () => {
  const failure = await readCommand(['/bin/sh', '-c', 'echo bad >&2; exit 2']).then(
    () => undefined,
    (error: unknown) => error,
  );

  expect(await readCommand(['/bin/sh', '-c', 'echo hello'])).toBe('hello\n');
  expect(failure).toMatchObject({ message: expect.stringContaining('exited 2: bad') });
});
