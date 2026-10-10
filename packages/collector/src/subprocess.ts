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
