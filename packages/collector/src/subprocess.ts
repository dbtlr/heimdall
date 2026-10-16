// How long a command may run before it is killed.
export const COMMAND_TIMEOUT_MS = 5000;

// What running a command came to: it exited, or it was killed for outliving
// its timeout.
export type CommandResult =
  | { exitCode: number; kind: 'exited'; stderr: string; stdout: string }
  | { kind: 'timed out' };

// Runs a command, which the caller names by absolute path since a launchd
// agent's or a systemd service's PATH is minimal, and answers how it ended. A
// command that outlives `timeoutMs` is killed. It rejects when the command
// cannot be started, such as when the file does not exist. A child that leaves
// a grandchild holding its output open would hold this until the grandchild
// exits, which the tools the Collector runs do not do.
export const runCommand = async (
  cmd: readonly string[],
  { timeoutMs = COMMAND_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<CommandResult> => {
  const child = Bun.spawn({ cmd: [...cmd], stderr: 'pipe', stdout: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return timedOut ? { kind: 'timed out' } : { exitCode, kind: 'exited', stderr, stdout };
  } finally {
    clearTimeout(timer);
  }
};

// Runs a command and answers what it wrote to standard output, throwing when it
// times out or exits non-zero. For readings the Collector cannot go on without.
export const readCommand = async (cmd: readonly string[]): Promise<string> => {
  const result = await runCommand(cmd);
  if (result.kind === 'timed out') {
    throw new Error(`${cmd.join(' ')} timed out after ${String(COMMAND_TIMEOUT_MS / 1000)} s`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(' ')} exited ${String(result.exitCode)}: ${result.stderr}`);
  }
  return result.stdout;
};

const cancelReader = async (reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'cancel'>) => {
  try {
    await reader.cancel();
  } catch {
    /* Failure already determines the command outcome. */
  }
};

// Update checks need a bounded byte stream and cancellation. Keep their extra
// failure states apart from existing command callers' exhaustive result handling.
export const runBoundedCommand = async (
  cmd: readonly string[],
  {
    env,
    maxOutputBytes = 4 * 1024 * 1024,
    signal,
    timeoutMs = COMMAND_TIMEOUT_MS,
  }: {
    env?: Record<string, string | undefined> | undefined;
    maxOutputBytes?: number;
    signal?: AbortSignal | undefined;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult | { kind: 'cancelled' | 'output exceeded' }> => {
  if (signal?.aborted) {
    return { kind: 'cancelled' };
  }
  // Timeout and shutdown kill descendants that remain in this process group.
  // Cancelling pipe readers below bounds completion when a descendant leaves it.
  const child = Bun.spawn({
    cmd: [...cmd],
    detached: true,
    ...(env === undefined ? {} : { env }),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  type Failure = { kind: 'cancelled' | 'output exceeded' | 'timed out' };
  let failure: Failure | undefined;
  const failed = Promise.withResolvers<Failure>();
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const kill = (kind: Failure['kind']) => {
    failure ??= { kind };
    failed.resolve(failure);
    // Descendants can create another process group. Cancelling our owned pipe
    // readers bounds completion even when such a descendant retains a pipe.
    void cancelReader(stdoutReader);
    void cancelReader(stderrReader);
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL');
      }
    } catch {
      child.kill('SIGKILL');
    }
  };
  const cancel = () => kill('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  const timer = setTimeout(() => kill('timed out'), timeoutMs);
  let bytes = 0;
  const read = async (reader: typeof stdoutReader) => {
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- Read bounded chunks from one pipe in order.
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > maxOutputBytes) {
          kill('output exceeded');
          break;
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      reader.releaseLock();
    }
  };
  const completion = async (): Promise<CommandResult | Failure> => {
    const [stdout, stderr, exitCode] = await Promise.all([
      read(stdoutReader),
      read(stderrReader),
      child.exited,
    ]);
    return failure ?? { exitCode, kind: 'exited', stderr, stdout };
  };
  try {
    return await Promise.race([completion(), failed.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
};
