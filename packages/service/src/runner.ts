// What a finished command reports.
export type CommandResult = { code: number; stderr: string; stdout: string };

// Runs one command, such as `systemctl --user restart <unit>`, and reports how it
// ended. Supervisor backends take one, so tests answer without a real manager.
export type CommandRunner = (argv: readonly string[]) => Promise<CommandResult>;

// How long a supervisor command may take. `service status` must answer Fleet
// even when the user manager does not.
const COMMAND_TIMEOUT_MS = 5000;

// The exit code `timeout(1)` reports for a command it stopped.
const TIMED_OUT = 124;

// The environment a command runs in. systemctl finds the user manager through
// XDG_RUNTIME_DIR, which a login session sets and `sudo -u` drops, so an unset
// one becomes the user's runtime directory.
const commandEnvironment = (env: Readonly<Record<string, string | undefined>>, uid: number) =>
  env.XDG_RUNTIME_DIR === undefined || env.XDG_RUNTIME_DIR === ''
    ? { ...env, XDG_RUNTIME_DIR: `/run/user/${String(uid)}` }
    : { ...env };

// A runner that spawns each command for real, with `env` as its environment,
// and stops one that runs past `timeoutMs`, which then reads as failed.
export const createSpawnRunner =
  ({
    env,
    timeoutMs = COMMAND_TIMEOUT_MS,
    uid,
  }: {
    env: Readonly<Record<string, string | undefined>>;
    timeoutMs?: number;
    uid: number;
  }): CommandRunner =>
  async (argv) => {
    const child = Bun.spawn([...argv], {
      env: commandEnvironment(env, uid),
      stderr: 'pipe',
      stdin: 'ignore',
      stdout: 'pipe',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return timedOut
        ? {
            code: TIMED_OUT,
            stderr: `${argv.join(' ')} timed out after ${String(timeoutMs / 1000)} s`,
            stdout,
          }
        : { code, stderr, stdout };
    } finally {
      clearTimeout(timer);
    }
  };
