import { expect, spyOn, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readCommand, runBoundedCommand, runCommand } from './subprocess.ts';
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

test('a command that ignores SIGTERM is still killed at the timeout', async () => {
  await using dir = await tempStateDir();
  const pidFile = join(dir.path, 'pid');

  const result = await runCommand(
    ['/bin/sh', '-c', `trap '' TERM; echo $$ > ${pidFile}; while :; do :; done`],
    { timeoutMs: 50 },
  );

  expect(result).toEqual({ kind: 'timed out' });
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  const deadline = Date.now() + 1000;
  while (isAlive(pid) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Wait for SIGKILL to be delivered and the process reaped.
    await Bun.sleep(2);
  }
  expect(isAlive(pid)).toBe(false);
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

test('bounded commands reject excess output and stop on cancellation', async () => {
  expect(await runBoundedCommand(['/bin/sh', '-c', 'yes output'], { maxOutputBytes: 128 })).toEqual(
    { kind: 'output exceeded' },
  );
  const controller = new AbortController();
  const pending = runBoundedCommand(['/bin/sleep', '30'], { signal: controller.signal });
  controller.abort();
  expect(await pending).toEqual({ kind: 'cancelled' });
});

test('bounded commands kill descendants that retain output pipes', async () => {
  await using dir = await tempStateDir();
  const pidFile = join(dir.path, 'descendant');
  const start = Date.now();
  const result = await runBoundedCommand(
    ['/bin/sh', '-c', `sleep 30 & echo $! > ${pidFile}; wait`],
    { timeoutMs: 100 },
  );
  expect(result).toEqual({ kind: 'timed out' });
  expect(Date.now() - start).toBeLessThan(1000);
  const pid = Number(await readFile(pidFile, 'utf8'));
  // Signal delivery is asynchronous; a killed orphan may then remain a zombie.
  const deadline = Date.now() + 1000;
  let status = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => '');
  while (status !== '' && !status.includes(') Z ') && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- Wait for the OS to deliver SIGKILL.
    await Bun.sleep(10);
    // oxlint-disable-next-line no-await-in-loop -- Recheck the process until it exits or the deadline passes.
    status = await readFile(`/proc/${String(pid)}/stat`, 'utf8').catch(() => '');
  }
  expect(status === '' || status.includes(') Z ')).toBe(true);
});

test('bounded command budget includes stdout and stderr together', async () => {
  expect(
    await runBoundedCommand(['/bin/sh', '-c', 'printf 123456789; printf 123456789 >&2'], {
      maxOutputBytes: 16,
    }),
  ).toEqual({ kind: 'output exceeded' });
});

for (const mode of ['timeout', 'abort'] as const) {
  test(`bounded command ${mode} releases pipes inherited by a detached descendant`, async () => {
    await using dir = await tempStateDir();
    const pidFile = join(dir.path, 'escaped-descendant');
    const controller = new AbortController();
    const started = Date.now();
    const pending = runBoundedCommand(
      [
        process.execPath,
        '--eval',
        "const child = Bun.spawn({ cmd: ['/bin/sleep', '2'], detached: true, stderr: 'inherit', stdout: 'inherit' }); await Bun.write(Bun.argv.at(-1), String(child.pid)); child.unref();",
        pidFile,
      ],
      { signal: controller.signal, timeoutMs: mode === 'timeout' ? 50 : 1000 },
    );
    if (mode === 'abort') {
      const deadline = Date.now() + 1000;
      // oxlint-disable-next-line no-await-in-loop -- Wait for the child to finish recording its descendant.
      while (!(await Bun.file(pidFile).exists()) && Date.now() < deadline) {
        // oxlint-disable-next-line no-await-in-loop -- The child records its detached descendant before cancellation.
        await Bun.sleep(2);
      }
      expect(await Bun.file(pidFile).exists()).toBe(true);
      controller.abort();
    }
    try {
      expect(await pending).toEqual({ kind: mode === 'abort' ? 'cancelled' : 'timed out' });
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      const pid = Number(await readFile(pidFile, 'utf8'));
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* It may have already exited. */
      }
    }
  });
}
